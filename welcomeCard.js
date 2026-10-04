// ================= [ مولّد بطاقة الترحيب المصورة ] =================
// يركّب صورة العضو الجديد داخل الدائرة السوداء بقالب الترحيب (assets/welcome-template.jpg)
// تم قياس إحداثيات الدائرة يدوياً من القالب نفسه (مقاس القالب 1024x1024).

const { createCanvas, loadImage } = require('@napi-rs/canvas');
const path = require('path');

const TEMPLATE_PATH = path.join(__dirname, 'assets', 'welcome-template.jpg');

// إحداثيات الدائرة السوداء بالقالب — لو غيّرت القالب لصورة ثانية، لازم تعيد قياس هالأرقام
const AVATAR_CIRCLE = { x: 462, y: 446, radius: 208 };

// نخزن القالب بالذاكرة بعد أول تحميل عشان ما نقرأه من القرص كل مرة عضو جديد يدخل
let cachedTemplate = null;
async function getTemplate() {
    if (!cachedTemplate) {
        cachedTemplate = await loadImage(TEMPLATE_PATH);
    }
    return cachedTemplate;
}

/**
 * يولّد بطاقة ترحيب PNG لعضو معين، برجع Buffer جاهز للإرسال بديسكورد.
 * @param {import('discord.js').GuildMember} member
 * @returns {Promise<Buffer>}
 */
async function generateWelcomeCard(member) {
    const canvas = createCanvas(1024, 1024);
    const ctx = canvas.getContext('2d');

    // ١) القالب كخلفية كاملة
    const template = await getTemplate();
    ctx.drawImage(template, 0, 0, 1024, 1024);

    // ٢) صورة العضو الشخصية (PNG بجودة 256px عشان تطلع واضحة)
    const avatarUrl = member.user.displayAvatarURL({ extension: 'png', size: 256 });
    const avatarImg = await loadImage(avatarUrl);

    // ٣) نقص الصورة دائرياً بنفس مكان الدائرة السوداء بالضبط
    ctx.save();
    ctx.beginPath();
    ctx.arc(AVATAR_CIRCLE.x, AVATAR_CIRCLE.y, AVATAR_CIRCLE.radius, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();

    const size = AVATAR_CIRCLE.radius * 2;
    ctx.drawImage(
        avatarImg,
        AVATAR_CIRCLE.x - AVATAR_CIRCLE.radius,
        AVATAR_CIRCLE.y - AVATAR_CIRCLE.radius,
        size,
        size
    );
    ctx.restore();

    return canvas.encode('png');
}

module.exports = { generateWelcomeCard };
