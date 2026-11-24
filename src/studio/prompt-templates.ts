import type { GenerationOptions } from './types.ts';

export interface PromptTemplate {
  id: string; group: string; name: string; subject: string; suggestedSize: string; tip: string;
  style: GenerationOptions['style']; view: GenerationOptions['view']; reference: boolean;
  brief: (subject: string) => string;
}
export const promptTemplates: readonly PromptTemplate[] = [
  { id: 'tiny-hero', group: 'Nhân vật', name: 'Nhân vật nhỏ · 16–24 px', subject: 'hiệp sĩ rừng đội mũ trùm xanh, cầm kiếm bạc ngắn', suggestedSize: '18×18', style: 'eight-bit', view: 'front', reference: false,
    tip: 'Canvas nhỏ: ưu tiên dáng, mặt và một phụ kiện; tránh cố nhồi chi tiết giáp hoặc họa tiết.',
    brief: s => `Vẽ ${s}, toàn thân đứng chính diện. Đầu, thân, hai chân và phụ kiện phải phân biệt được khi xem ở 1×. Giữ dáng gọn, biểu cảm thân thiện; dùng các mảng màu lớn, ít sắc độ. Không vẽ chi tiết trang trí nếu chúng làm mặt hoặc tay khó đọc.` },
  { id: 'hero', group: 'Nhân vật', name: 'Nhân vật chi tiết · 48–128 px', subject: 'nữ thám hiểm tóc nâu, áo choàng xanh, túi da và gậy gỗ', suggestedSize: '64×64', style: 'game', view: 'front', reference: false,
    tip: 'Chọn một điểm nhấn chính; mặt và trang phục cần có độ sáng khác nhau để không hòa thành một khối.',
    brief: s => `Vẽ ${s}, toàn thân đứng chính diện, tư thế cân bằng. Làm rõ mặt, tóc, thân, tay, chân và phụ kiện. Tạo một điểm nhấn ở khuôn mặt; trang phục có nếp gấp chọn lọc, mỗi vật liệu 2–3 sắc độ. Ánh sáng từ trên trái, bóng nằm ở phía đối diện. Giữ silhouette rõ thay vì phủ kín bằng họa tiết.` },
  { id: 'top-down', group: 'Nhân vật', name: 'Nhân vật nhìn từ trên xuống', subject: 'người đưa thư đội mũ đỏ, mang túi da bên hông', suggestedSize: '32×32 hoặc 48×48', style: 'game', view: 'top-down', reference: false,
    tip: 'Giữ góc máy thống nhất giữa các asset cùng game. Mẫu này tạo một nhân vật, không tạo bộ nhiều hướng.',
    brief: s => `Vẽ ${s}, một nhân vật nhìn từ trên xuống dùng trong game khám phá. Thể hiện đỉnh đầu/mũ, vai và phần chân theo cùng góc máy; tránh biến thành chân dung chính diện. Đặt trọng tâm gần giữa canvas; làm rõ phụ kiện đặc trưng bằng mảng màu tương phản. Chỉ tạo một dáng và một hướng.` },
  { id: 'slime', group: 'Quái', name: 'Quái nhỏ dễ đọc', subject: 'slime xanh lá có đôi mắt vàng và một chiếc lá trên đầu', suggestedSize: '24×24 hoặc 32×32', style: 'game', view: 'front', reference: false,
    tip: 'Mắt và đường bao nên nổi bật trên màu cơ thể; không cần nhiều đốm sáng nhỏ.',
    brief: s => `Vẽ ${s}, quái nhỏ nhìn chính diện, dáng thấp và trọng lượng rõ. Đường bao sạch, mắt dễ thấy ở kích thước gốc; một vùng sáng lớn và bóng ở đáy đủ gợi khối. Phụ kiện không lẫn vào mắt. Giữ vẻ sinh động bằng hình dáng, không dùng nhiều pixel sáng rời rạc.` },
  { id: 'potion', group: 'Vật phẩm', name: 'Icon bình thuốc', subject: 'bình hồi máu bằng thủy tinh, chất lỏng đỏ, nút bần', suggestedSize: '32×32', style: 'flat-icon', view: 'description', reference: false,
    tip: 'Nền ảnh vẫn trong suốt; tạo cảm giác thủy tinh bằng mảng màu, không cần alpha bán trong suốt.',
    brief: s => `Vẽ icon ${s} ở chính giữa, toàn bộ vật phẩm nằm trong canvas. Tách rõ nút, cổ bình, thân và mặt chất lỏng. Dùng đường bao tối, một mảng phản sáng gọn trên trái; chất lỏng là điểm nhấn. Gợi thủy tinh bằng pixel màu đặc, không dùng blur hoặc độ trong suốt bán phần. Không chữ, khung hay huy hiệu.` },
  { id: 'weapon', group: 'Vật phẩm', name: 'Icon vũ khí / dụng cụ', subject: 'kiếm bạc ngắn, chuôi bọc da nâu, chắn tay bằng vàng', suggestedSize: '32×32 hoặc 48×48', style: 'flat-icon', view: 'description', reference: false,
    tip: 'Với canvas chữ nhật, để vật phẩm theo trục dài thay vì cắt mất đầu hoặc chuôi.',
    brief: s => `Vẽ icon ${s}, chỉ một vật phẩm. Đặt chéo nếu canvas gần vuông, theo trục dài nếu canvas chữ nhật; giữ toàn bộ hai đầu trong khung. Phân biệt phần làm việc, tay cầm và khớp nối bằng hình dáng và độ sáng. Dùng một cạnh sáng, một cạnh tối để gợi kim loại; không thêm hào quang hoặc nền.` },
  { id: 'chest', group: 'Đạo cụ', name: 'Rương / đạo cụ chữ nhật', subject: 'rương gỗ đóng nắp, đai vàng, ổ khóa giữa', suggestedSize: '48×32', style: 'game', view: 'description', reference: false,
    tip: 'Tạo canvas chữ nhật trước nếu muốn dáng ngang; dùng mẫu không tự đổi kích thước.',
    brief: s => `Vẽ ${s}, góc nhìn ba phần tư nhẹ để thấy mặt trước, nắp và một cạnh bên. Tách các mặt bằng độ sáng; cạnh bên tối hơn, mặt trên sáng hơn. Chi tiết chính phải cân bằng và dễ nhận ra; chỉ dùng vài vệt gỗ chọn lọc. Giữ phối cảnh nhất quán, toàn bộ đạo cụ nằm trong canvas, không thêm sàn hoặc bóng rời ngoài hình.` },
  { id: 'tree', group: 'Đạo cụ', name: 'Cây / thực vật game', subject: 'cây sồi nhỏ, tán xanh tròn, thân nâu có rễ gọn', suggestedSize: '48×64 hoặc 64×64', style: 'game', view: 'description', reference: false,
    tip: 'Chia tán cây thành vài khối sáng/tối lớn; tránh rải từng chấm lá ngẫu nhiên.',
    brief: s => `Vẽ ${s}, góc nhìn ba phần tư nhẹ dùng cho đạo cụ game. Tán lá gồm vài cụm lớn liên kết, có khoảng lõm tự nhiên; thân đọc rõ và đặt dưới trọng tâm tán. Ánh sáng trên trái, vùng tối tập trung dưới tán. Không vẽ từng lá hoặc hạt nhiễu; không nền phong cảnh. Chừa khoảng thở quanh đường bao.` },
  { id: 'idle', group: 'Animation', name: 'Idle nhẹ · 4 frame', subject: 'mèo cam đứng, tai nhọn và đuôi cong', suggestedSize: '32×32 hoặc 64×64', style: 'game', view: 'front', reference: false,
    tip: 'Mỗi frame dùng toàn bộ kích thước canvas. Giữ chân cố định để nhân vật không trượt khi phát.',
    brief: s => `Tạo đúng một animation idle 4 frame của ${s}, chính diện. Mỗi frame 100 ms, phát lặp. Frame 1 tư thế nghỉ, frame 2 nâng thân nhẹ, frame 3 trở về, frame 4 chớp mắt. Chân và điểm tiếp đất cố định; chỉ dịch thân tối đa 1 pixel. Giữ nguyên tỷ lệ, palette và phụ kiện giữa các frame. Không xuất bốn nhân vật cạnh nhau; dùng các frame animation độc lập trên cùng canvas.` },
  { id: 'impact', group: 'Animation', name: 'Hiệu ứng va chạm · 6 frame', subject: 'tia va chạm vàng cam dạng ngôi sao', suggestedSize: '32×32 hoặc 48×48', style: 'eight-bit', view: 'description', reference: false,
    tip: 'Hiệu ứng này chạy một lần; không dùng frame rỗng để giấu lỗi hình dáng hoặc timing.',
    brief: s => `Tạo đúng một animation ${s} gồm 6 frame, mỗi frame 60 ms, chạy một lần rồi giữ frame cuối. Tâm hiệu ứng cố định. Diễn tiến: chấm sáng nhỏ → tia ngắn → bùng lớn → tia tách → tàn nhỏ → một đốm tàn nhìn thấy. Dùng các cụm pixel màu đặc, thay đổi diện tích thay vì fade alpha. Không nhấp nháy toàn nền, không blur, không dựng một sprite sheet thay cho animation.` },
  { id: 'recolor', group: 'Sửa ảnh tham chiếu', name: 'Đổi màu, giữ thiết kế chính', subject: 'đổi phần áo choàng sang đỏ gạch, giữ màu da và vũ khí', suggestedSize: 'Giữ canvas hiện tại', style: 'game', view: 'description', reference: true,
    tip: 'Mẫu bật tham chiếu frame 1. AI tạo asset mới, không bảo đảm giữ nguyên từng pixel; hãy so sánh trước khi Áp dụng. Palette cần có màu bạn muốn đổi.',
    brief: s => `Dựa vào ảnh tham chiếu frame đầu của asset hiện tại: ${s}. Ưu tiên giữ silhouette, tỷ lệ, tư thế, góc nhìn, vị trí các bộ phận và chi tiết nhận diện. Chỉ thay đổi nhóm màu được yêu cầu; duy trì chênh lệch sáng/tối để còn thấy khối. Không tự thêm phụ kiện hoặc đổi bố cục. Trả một asset đầy đủ để so sánh, không trả riêng phần overlay.` },
];

export function buildTemplatePrompt(template: PromptTemplate, w: number, h: number, subject = template.subject): string {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 4096 || h > 4096) throw new Error('Chọn canvas hợp lệ trước khi dùng mẫu.');
  const detail = Math.min(w, h) <= 24 ? 'Ở kích thước nhỏ này, ưu tiên dáng và 1–2 chi tiết nhận diện; bỏ chi tiết không đọc được ở 1×.' : Math.min(w, h) <= 48 ? 'Giữ các mảng chính rõ; chỉ thêm chi tiết khi không làm nhiễu đường bao hoặc điểm nhấn.' : 'Tận dụng độ phân giải cho các mảng vật liệu và bóng có chủ đích, không phủ bề mặt bằng nhiễu pixel.';
  return `Canvas đầu ra ${w}×${h} px, đúng kích thước hiện tại; không đổi canvas hoặc cắt hình.\n\n${template.brief(subject.trim() || template.subject)}\n\n${detail}\nNền trong suốt; dùng palette đã chọn trong giao diện, không tự đổi chế độ palette. Không làm mượt, gradient hoặc pixel bán trong suốt. Kiểm tra hình ở kích thước gốc; chỉ trả một phương án hoàn chỉnh.`;
}
