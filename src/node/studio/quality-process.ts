import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { QualityOwnedTask } from './quality-ports.ts';

export interface QualityProcessResult { code: number; stdout: string; stderr: string; completedStop?: true }
export interface QualityProcessInput {
  executable: string; args: string[]; cwd: string; input?: string; budgetMs: number;
  completedOutput?: (stdout: string) => boolean;
}

function codexProgress(stdout: Buffer, stderr: Buffer): string {
  let phase = 'chưa có sự kiện JSON tiến trình';
  for (const line of stdout.toString('utf8').split('\n')) {
    let event: { type?: unknown; item?: { type?: unknown } } | null;
    try { event = JSON.parse(line); } catch { continue; }
    switch (event?.type) {
      case 'thread.started': phase = 'đã mở phiên'; break;
      case 'turn.started': phase = 'đã bắt đầu lượt'; break;
      case 'item.started': case 'item.updated': case 'item.completed':
        phase = event.item?.type === 'reasoning' ? 'đã phát sự kiện suy luận'
          : event.item?.type === 'agent_message' ? 'đã phát sự kiện phản hồi' : 'đã phát sự kiện xử lý';
        break;
      case 'turn.completed': phase = 'đã báo hoàn thành lượt'; break;
      case 'turn.failed': case 'error': phase = 'đã phát sự kiện lỗi'; break;
    }
  }
  // Retain stages and sizes only. CLI events and stderr may contain paths, prompts or credentials.
  return `Tiến trình Codex: ${phase}. Đã nhận ${stdout.length} byte stdout và giữ ${stderr.length} byte stderr.`;
}
/**
 * Environment for every CLI child. The DeepSeek key is server-only and must not
 * reach a CLI provider (or its descendants). Windows environment names are
 * case-insensitive, so the key is filtered case-insensitively on every platform.
 */
export function studioCliEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase() === 'PXL_DEEPSEEK_API_KEY') continue;
    env[key] = value;
  }
  return env;
}

// No shell is involved in the provider command. On Windows the suspended child
// joins a non-breakaway Job Object before its first instruction. Closing only
// the root PID is insufficient: a CLI may leave a child/browser helper alive.
const windowsSupervisor = String.raw`
using System;
using System.Text;
using System.IO;
using System.Runtime.InteropServices;
using System.ComponentModel;
using System.Threading;
public static class LumaQualitySupervisor {
 [StructLayout(LayoutKind.Sequential)] struct Limits { public long processTime, jobTime; public uint flags; public UIntPtr minWS,maxWS; public uint maxProcesses; public UIntPtr affinity; public uint priority,scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a,b,c,d,e,f; }
 [StructLayout(LayoutKind.Sequential)] struct Extended { public Limits basic; public IO io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
 [StructLayout(LayoutKind.Sequential)] struct Accounting { public long a,b,c,d; public uint faults,total,active,terminated; }
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup { public uint cb; public string reserved,desktop,title; public uint x,y,w,h,xChars,yChars,fill,flags; public ushort show,extra; public IntPtr extraData,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
 [StructLayout(LayoutKind.Sequential)] struct Security { public uint length; public IntPtr descriptor; public int inherit; }
 [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr sa,string name);
 [DllImport("kernel32", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,ref Extended value,uint size);
 [DllImport("kernel32", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int info,out Accounting value,uint size,IntPtr returned);
 [DllImport("kernel32", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32", SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string exe,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup startup,out ProcessInfo process);
 [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string name,uint access,uint share,ref Security sa,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32")] static extern IntPtr GetStdHandle(int id);
 [DllImport("kernel32", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
 [DllImport("kernel32", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32")] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
 [DllImport("kernel32")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32")] static extern bool CloseHandle(IntPtr handle);
 static void Check(bool ok) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
 static string Quote(string value) {
  StringBuilder b=new StringBuilder("\""); int slashes=0;
  foreach(char c in value) { if(c=='\\') { slashes++; continue; } if(c=='"') b.Append('\\',slashes*2+1); else b.Append('\\',slashes); b.Append(c); slashes=0; }
  return b.Append('\\',slashes*2).Append('"').ToString();
 }
 static uint Active(IntPtr job) { Accounting a; Check(QueryInformationJobObject(job,1,out a,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)); return a.active; }
 public static int Run(string exe,string[] args,string cwd,string stdin,string stop,string receipt,int budget) {
  IntPtr job=IntPtr.Zero,input=IntPtr.Zero; ProcessInfo p=new ProcessInfo(); bool assigned=false,confirmed=false,requested=false; uint code=1; string error=null;
  var clock=System.Diagnostics.Stopwatch.StartNew();
  try {
   job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
   Extended limits=new Extended(); limits.basic.flags=0x2000; Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(Extended))));
   if(File.Exists(stop)) { confirmed=true; code=130; }
   else {
    Security sa=new Security(); sa.length=(uint)Marshal.SizeOf(typeof(Security)); sa.inherit=1;
    input=CreateFile(stdin,0x80000000,3,ref sa,3,0,IntPtr.Zero); Check(input!=new IntPtr(-1));
    Startup s=new Startup(); s.cb=(uint)Marshal.SizeOf(typeof(Startup)); s.flags=0x100; s.input=input; s.output=GetStdHandle(-11); s.error=GetStdHandle(-12);
    Check(SetHandleInformation(s.output,1,1)); Check(SetHandleInformation(s.error,1,1));
    StringBuilder cmd=new StringBuilder(Quote(exe)); foreach(string a in args) cmd.Append(' ').Append(Quote(a));
    Check(CreateProcess(exe,cmd,IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,cwd,ref s,out p));
    Check(AssignProcessToJobObject(job,p.process)); assigned=true;
    if(File.Exists(stop)) Check(TerminateJobObject(job,130)); else Check(ResumeThread(p.thread)!=0xffffffff);
    while(WaitForSingleObject(p.process,25)!=0) {
     if(File.Exists(stop)||clock.ElapsedMilliseconds>=budget) { requested=File.Exists(stop); Check(TerminateJobObject(job,130)); break; }
    }
    // The root can exit before an inherited grandchild. Kill any leftover work
    // before releasing the lease or allowing another stage to start.
    if(Active(job)>0) Check(TerminateJobObject(job,130));
    for(int i=0;i<80&&Active(job)>0;i++) Thread.Sleep(25);
    // Job accounting can reach zero just before the process handle is signaled.
    confirmed=Active(job)==0&&WaitForSingleObject(p.process,1500)==0;
    if(!confirmed) Console.Error.WriteLine("Job shutdown pending: active="+Active(job)+", wait="+WaitForSingleObject(p.process,0));
    Check(GetExitCodeProcess(p.process,out code));
   }
  } catch(Exception e) {
   error=e.Message;
   if(p.process!=IntPtr.Zero) { if(assigned) TerminateJobObject(job,130); else TerminateProcess(p.process,130); WaitForSingleObject(p.process,3000); }
   try { confirmed=(p.process==IntPtr.Zero||WaitForSingleObject(p.process,0)==0)&&(job==IntPtr.Zero||Active(job)==0); } catch { confirmed=false; }
  } finally {
   if(p.thread!=IntPtr.Zero) CloseHandle(p.thread); if(p.process!=IntPtr.Zero) CloseHandle(p.process); if(input!=IntPtr.Zero&&input!=new IntPtr(-1)) CloseHandle(input); if(job!=IntPtr.Zero) CloseHandle(job);
   // Error text goes to stderr; the receipt has only local primitive fields.
   if(error!=null) Console.Error.WriteLine("Owned CLI supervisor: "+error);
   File.WriteAllText(receipt,"{\"confirmed\":"+(confirmed?"true":"false")+",\"code\":"+code+",\"pid\":"+p.pid+",\"error\":"+(error==null?"false":"true")+",\"requested\":"+(requested?"true":"false")+"}");
  }
  return confirmed&&error==null?0:1;
 }
}
`;

/** cwd is a newly allocated, trusted per-call directory, never an HTTP path. */
export function startQualityProcess(request: QualityProcessInput): QualityOwnedTask<QualityProcessResult> {
  const work = request.cwd, stopPath = join(work, 'owned-stop'), receiptPath = join(work, 'owned-receipt.json');
  let child: ChildProcess, closed = false, requestedStop = false, timeout = false, tooLarge = false;
  let output = Buffer.alloc(0), error = Buffer.alloc(0), launchError: Error | undefined, diagnostic = '';
  let gracefulExit: NodeJS.Timeout | undefined, completedStop = false;
  const budget = Math.max(1, Math.min(300_000, Math.floor(request.budgetMs)));
  if (!Number.isFinite(request.budgetMs) || request.budgetMs <= 0) throw Error('CLI không còn ngân sách chạy.');
  // One restricted snapshot for the owned supervisor on every platform; process.env is untouched.
  const env = studioCliEnvironment();
  if (process.platform === 'win32') {
    const source = join(work, 'owned-supervisor.cs'), config = join(work, 'owned-input.json');
    writeFileSync(source, windowsSupervisor, { flag: 'wx' });
    const stdin = request.input === undefined ? 'NUL' : join(work, 'owned-stdin.txt');
    if (request.input !== undefined) writeFileSync(stdin, request.input, { flag: 'wx' });
    writeFileSync(config, JSON.stringify({ exe: request.executable, args: request.args, work, source, stdin, stop: stopPath, receipt: receiptPath, budget }), { flag: 'wx' });
    const script = '$ErrorActionPreference="Stop"; $ProgressPreference="SilentlyContinue"; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); $invoked=$false; try { $q=[Console]::In.ReadToEnd()|ConvertFrom-Json; [IO.File]::WriteAllText((Join-Path $q.work "owned-helper.json"),(@{pid=$PID;startedUtc=[Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().ToString("o")}|ConvertTo-Json -Compress)); Add-Type -Path $q.source; $invoked=$true; exit ([LumaQualitySupervisor]::Run($q.exe,[string[]]$q.args,$q.work,$q.stdin,$q.stop,$q.receipt,[int]$q.budget)) } catch { [Console]::Error.WriteLine($_.Exception.Message); if(!$invoked -and $q.receipt) { [IO.File]::WriteAllText($q.receipt,\'{"confirmed":true,"error":true,"code":1,"pid":0}\') }; exit 1 }';
    child = spawn(join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { cwd: work, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin!.on('error', () => {}); child.stdin!.end(readFileSync(config));
  } else {
    child = spawn(request.executable, request.args, { cwd: work, env, detached: true, shell: false, stdio: [request.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    child.stdin?.on('error', () => {}); child.stdin?.end(request.input);
  }
  const signalStop = () => {
    try {
      if (process.platform === 'win32') { if (!existsSync(stopPath)) writeFileSync(stopPath, '', { flag: 'wx' }); }
      else if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; } }
    } catch (e) { diagnostic = `Không gửi được yêu cầu dừng: ${(e as Error).message}`; }
  };
  const confirmed = (): boolean => {
    if (!closed) return false;
    if (process.platform === 'win32') {
      try { const r = JSON.parse(readFileSync(receiptPath, 'utf8')); return r.confirmed === true; }
      catch { return !!launchError; /* No child was created when spawning the supervisor failed. */ }
    }
    if (!child.pid) return true;
    try { process.kill(-child.pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH'; }
  };
  const timer = setTimeout(() => { timeout = true; requestedStop = true; signalStop(); }, budget);
  child.stdout!.on('data', (chunk: Buffer) => {
    const remaining = 8_000_000 - output.length;
    output = Buffer.concat([output, chunk.subarray(0, Math.max(0, remaining))]);
    if (chunk.length > remaining && !tooLarge) { tooLarge = true; requestedStop = true; signalStop(); }
    if (request.completedOutput && !gracefulExit && !completedStop && !requestedStop && output.includes('"turn.completed"')) {
      // Give Codex normal time to exit before reclaiming an owned tree with a sealed response.
      gracefulExit = setTimeout(() => {
        gracefulExit = undefined;
        if (closed || requestedStop || !request.completedOutput!(output.toString('utf8'))) return;
        completedStop = true;
        signalStop();
      }, 1500);
    }
  });
  child.stderr!.on('data', (chunk: Buffer) => { error = Buffer.concat([error, chunk]).subarray(-12000); });
  const promise = new Promise<QualityProcessResult>((resolve, reject) => {
    child.once('error', e => { launchError = e; });
    child.once('close', (code, signal) => {
      closed = true; clearTimeout(timer); clearTimeout(gracefulExit);
      if (process.platform !== 'win32') signalStop();
      if (!confirmed()) {
        diagnostic = 'Chưa xác nhận toàn bộ tiến trình CLI đã dừng.';
        // Do not reject a normal task result while descendants are uncertain:
        // the engine's timeout/cancel must keep its active handle and lease.
        return;
      }
      if (launchError) { reject(Error(`Không chạy được CLI: ${launchError.message}`)); return; }
      if (requestedStop) { reject(Error(tooLarge ? 'CLI trả quá 8 MB dữ liệu.' : timeout ? `CLI vượt thời gian cho phép. ${codexProgress(output, error)}` : 'Đã hủy CLI.')); return; }
      let stoppedBySignal = signal === 'SIGKILL';
      if (process.platform === 'win32') {
        const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
        if (receipt.error) { reject(Error(`Không chạy được CLI: ${error.toString('utf8')}`)); return; }
        code = receipt.code;
        stoppedBySignal = receipt.requested === true && code === 130;
      }
      const cleanCompletedStop = completedStop && stoppedBySignal;
      resolve({
        code: cleanCompletedStop ? 0 : code ?? 1, stdout: output.toString('utf8'), stderr: error.toString('utf8'),
        ...(cleanCompletedStop ? { completedStop: true as const } : {}),
      });
    });
  });
  // A caller may cancel before it starts awaiting the result.
  void promise.catch(() => {});
  return { promise, diagnostic: () => [diagnostic, codexProgress(output, error)].filter(Boolean).join(' '), stop: async deadline => {
    if (confirmed()) return true;
    requestedStop = true; signalStop();
    // Convert the caller's wall deadline once; waiting itself is monotonic.
    const end = performance.now() + Math.max(0, Math.min(5000, deadline - Date.now()));
    while (!confirmed() && performance.now() < end) await new Promise(r => setTimeout(r, 20));
    return confirmed();
  } };
}
