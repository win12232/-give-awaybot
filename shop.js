// ================= [ إعدادات متجر رتب VIP ] =================
// أسعار عالية عمداً بناءً على طلب صاحب البوت — تخلي الرتبة إنجاز حقيقي يستحق الفخر،
// مو شي يوصله أي عضو بيوم وحد. الأسعار مبنية على معدل كسب النقاط الفعلي بالبوت
// (10-15 نقطة لكل فوز بلعبة، 50-100 نقطة يومياً من /يومي).

const VIP_TIERS = {
    bronze: {
        key: 'bronze',
        name: 'VIP البرونزي',
        emoji: '🥉',
        price: 2000,
        color: '#C97B4A',
        roleName: '🥉 VIP البرونزي',
        pointsMultiplier: 1,     // بدون مضاعفة نقاط — الميزة هنا رمزية (لون + شارة)
        perks: [
            'لون مميز لاسمك بالسيرفر',
            'شارة VIP تظهر بجانب اسمك',
            'أولوية بالرد على استفساراتك'
        ]
    },
    silver: {
        key: 'silver',
        name: 'VIP الفضي',
        emoji: '🥈',
        price: 6000,
        color: '#9DA7B5',
        roleName: '🥈 VIP الفضي',
        pointsMultiplier: 1.25,  // +25% نقاط من الألعاب والمكافأة اليومية
        perks: [
            'كل مزايا البرونزي',
            '+25% نقاط إضافية من الألعاب والمكافأة اليومية',
            'دخول مبكر لأي فعالية جديدة'
        ]
    },
    gold: {
        key: 'gold',
        name: 'VIP الذهبي',
        emoji: '🥇',
        price: 15000,
        color: '#E4B343',
        roleName: '🥇 VIP الذهبي',
        pointsMultiplier: 1.5,   // +50%
        perks: [
            'كل مزايا الفضي',
            '+50% نقاط إضافية من الألعاب والمكافأة اليومية',
            'رتبة تظهر بأعلى قائمة الأعضاء'
        ]
    },
    diamond: {
        key: 'diamond',
        name: 'VIP الماسي',
        emoji: '💎',
        price: 35000,
        color: '#4FD1C5',
        roleName: '💎 VIP الماسي',
        pointsMultiplier: 2,     // مضاعفة كاملة
        perks: [
            'كل مزايا الذهبي',
            'مضاعفة كاملة (2x) لكل النقاط المكتسبة',
            'أعلى رتبة بالسيرفر — امتياز حصري للأعضاء الأكثر التزاماً'
        ]
    }
};

const VIP_TIER_ORDER = ['bronze', 'silver', 'gold', 'diamond'];

/**
 * يرجع أعلى مضاعف نقاط يملكه العضو بناءً على رتب الـ VIP اللي عنده فعلياً بديسكورد
 * (نتحقق من الرول نفسه مو بس قاعدة البيانات، عشان لو حذف الأدمن الرول يدوياً ينوقف المضاعف تلقائياً)
 * @param {import('discord.js').GuildMember} member
 * @returns {number}
 */
function getVipMultiplier(member) {
    if (!member) return 1;
    let highest = 1;
    for (const tierKey of VIP_TIER_ORDER) {
        const tier = VIP_TIERS[tierKey];
        const hasRole = member.roles.cache.some(r => r.name === tier.roleName);
        if (hasRole && tier.pointsMultiplier > highest) {
            highest = tier.pointsMultiplier;
        }
    }
    return highest;
}

module.exports = { VIP_TIERS, VIP_TIER_ORDER, getVipMultiplier };
