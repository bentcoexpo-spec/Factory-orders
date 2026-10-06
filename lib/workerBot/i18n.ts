// Все тексты бота работников на двух языках. Словарь uz объявлен как «те же
// ключи, что у ru» — если строка не переведена, проект не соберётся. Имена,
// названия моделей и операций — данные, подставляются как есть.
// Значения-параметры экранируются (parse_mode HTML); готовый HTML — raw().

export type Lang = 'ru' | 'uz';

class Raw {
  readonly html: string;
  constructor(html: string) {
    this.html = html;
  }
}
export const raw = (html: string) => new Raw(html);
export type Params = Record<string, string | number | Raw>;

export function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const ru = {
  // --- общее
  'lang.choose': 'Выберите язык',
  'lang.ru': 'Русский',
  'lang.uz': "O'zbekcha",
  'lang.changed': 'Язык: русский.',
  'btn.cancel': '❌ Отмена',
  'btn.back': '← Назад',
  'err.generic': 'Что-то пошло не так. Попробуйте ещё раз чуть позже.',
  'err.stale': 'Это действие уже неактуально. Нажмите «Добавить работу», чтобы начать заново.',
  currency: 'сум',
  pcs: 'шт',
  'shop.factory': 'Фабрика',
  'shop.workshop': 'Цех',

  // --- вход работника
  'w.noLink': 'Чтобы войти в бот, нужна ссылка-приглашение от мастера. Попросите её у мастера.',
  'w.badLink': 'Ссылка недействительна или отключена. Попросите у мастера новую ссылку.',
  'w.rejected': 'Ваша заявка была отклонена. Чтобы подать новую, попросите у мастера новую ссылку.',
  'w.pending': 'Заявка отправлена мастеру. Дождитесь решения — вам придёт сообщение.',
  'w.askName': 'Напишите ваши имя и фамилию.',
  'w.badName': 'Имя должно состоять из 2–40 букв. Попробуйте ещё раз.',
  'w.submitted': 'Спасибо, {name}! Заявка отправлена мастеру. Когда он её рассмотрит, вам придёт сообщение.',
  'w.approved': '✅ Мастер принял вашу заявку. Теперь вы можете добавлять работу.',
  'w.rejectedNotice': '❌ Мастер отклонил вашу заявку. Если это ошибка — попросите у мастера новую ссылку.',
  'w.removedNotice': 'Вы отключены от бота. Чтобы войти снова, попросите у мастера новую ссылку.',
  'w.notActive': 'Вы не подключены к боту. Попросите у мастера ссылку-приглашение.',
  'w.noEmployee': 'Мастер ещё не привязал вас к списку сотрудников. Обратитесь к мастеру.',
  'w.alreadyActive': 'Вы уже подключены. Выберите действие в меню.',
  'w.isStaff': 'Этот Telegram подключён как мастер или директор — работать здесь как работник нельзя.',

  // --- меню
  'menu.add': '➕ Добавить работу',
  'menu.stats': '📊 Моя статистика',
  'menu.title': 'Выберите действие:',

  // --- добавить работу
  'add.noProfession': 'У вас не указана профессия. Напишите мастеру — он укажет её в табеле.',
  'add.emptyCatalog': 'Для вашей профессии в каталоге пока нет операций с расценкой. Обратитесь к мастеру.',
  'add.kind': 'Что вы сделали?',
  'add.kindWhole': 'Целое изделие',
  'add.kindOp': 'Операция',
  'add.pickModel': 'Выберите модель:',
  'add.pickOp': 'Модель «{model}». Выберите операцию:',
  'add.askQty': '{label}\nСколько штук? Напишите целое число.',
  'add.badQty': 'Нужно целое число от 1 до 99999. Попробуйте ещё раз.',
  'add.review': 'Проверьте запись:\n{label}\n{qty} шт × {rate} = <b>{total}</b>\nДата: {date}',
  'add.confirm': '✅ Подтвердить',
  'add.cancelled': 'Отменено, ничего не сохранено.',
  'add.saved':
    '✅ Сохранено\n{label}\n{qty} шт × {rate} = <b>{total}</b>\nМастер ещё должен подтвердить запись — до этого она не идёт в оплату.',
  'add.again': '➕ Добавить ещё',
  'add.fix': '✏️ Исправить записи',
  'add.gone': 'Эта позиция больше недоступна в каталоге. Начните заново.',
  'add.wholeSuffix': 'целиком',

  // --- статистика
  'stats.pick': 'За какой период?',
  'stats.today': 'Сегодня',
  'stats.week': 'Неделя',
  'stats.month': 'Месяц',
  'stats.titleDay': '📊 <b>Сегодня, {date}</b>',
  'stats.titleWeek': '📊 <b>Неделя: {from} – {to}</b>',
  'stats.titleMonth': '📊 <b>Месяц: {from} – {to}</b>',
  'stats.confirmed': '✅ <b>Подтверждено мастером</b>',
  'stats.pending': '⏳ <b>Ждёт подтверждения</b>',
  'stats.ops': 'Операции:',
  'stats.whole': 'Целые изделия:',
  'stats.item': '• {label} — {qty} шт × {rate} = {sum}',
  'stats.sub': 'Итого: {qty} шт — <b>{sum}</b>',
  'stats.empty': 'За этот период записей нет.',
  'stats.rejected': '❌ Отклонено мастером записей: {n}',
  'stats.compare': '↔️ Прошлая неделя за тот же период: {prev}. Эта неделя: {cur}. {diff}',
  'stats.up': '▲ больше на {n}',
  'stats.down': '▼ меньше на {n}',
  'stats.same': 'без изменений',
  'stats.fix': '✏️ Исправить записи за сегодня',

  // --- исправление
  'edit.title': 'Записи за сегодня, которые ещё можно исправить:',
  'edit.none':
    'Сегодня нет записей, которые можно исправить. Исправлять можно только свои записи за сегодня, пока мастер их не подтвердил.',
  'edit.card': '{label}\n{qty} шт × {rate} = <b>{total}</b>\nЧто сделать?',
  'edit.btnQty': '✏️ Изменить количество',
  'edit.btnDel': '🗑 Удалить',
  'edit.askQty': 'Новое количество для «{label}» (сейчас {qty} шт). Напишите целое число.',
  'edit.updated': '✅ Исправлено: {label}\n{qty} шт × {rate} = <b>{total}</b>',
  'edit.confirmDel': 'Удалить запись «{label}», {qty} шт?',
  'edit.yesDel': 'Да, удалить',
  'edit.no': 'Нет',
  'edit.deleted': '🗑 Запись удалена.',
  'edit.locked': 'Эту запись уже нельзя исправить: её подтвердил мастер или день закончился.',

  // --- мастер / директор
  'role.master': 'мастер',
  'role.ceo': 'директор',
  's.hello': 'Вы подключены как {role}. Сюда приходят заявки работников на вход в бот.\nСменить язык: /lang',
  's.linked': '✅ Telegram подключён к вашему аккаунту ({role}). Заявки работников будут приходить сюда.',
  's.badCode': 'Код неверный или устарел. Создайте новый код на сайте (раздел «Бот»).',
  's.alreadyLinked': 'Этот Telegram уже подключён к другому аккаунту. Сначала отвяжите его на сайте.',
  's.isWorker': 'Этот Telegram зарегистрирован как работник. Для мастера нужен другой аккаунт Telegram.',
  's.request': '🆕 <b>Новая заявка в бот</b>\nИмя: {name}\nЦех: {shop}\nПрофессия: {profession}',
  's.approve': '✅ Принять',
  's.reject': '❌ Отклонить',
  's.pickEmployee':
    'Кого из табеля цеха «{shop}» привязать к работнику «{name}»? Или создайте нового сотрудника.',
  's.newEmployee': '➕ Создать сотрудника «{name}»',
  's.approved': '✅ Принят: {name} → сотрудник «{employee}»',
  's.rejected': '❌ Отклонено: {name}',
  's.alreadyDecided': 'Эта заявка уже обработана.',
  's.notYourShop': 'Заявка из другого цеха. Сначала выберите нужный цех на сайте.',
  's.nameTaken': 'Сотрудник с таким именем уже есть в табеле — выберите его из списка.',
  's.employeeTaken': 'Этот сотрудник уже привязан к другому работнику.',
  's.stale': 'Список устарел — откройте заявку заново.',
  's.noProfession': 'не указана',
  's.notStaff': 'Нет доступа.',
} as const;

export type MessageKey = keyof typeof ru;

const uz: Record<MessageKey, string> = {
  'lang.choose': 'Tilni tanlang',
  'lang.ru': 'Русский',
  'lang.uz': "O'zbekcha",
  'lang.changed': "Til: o'zbekcha.",
  'btn.cancel': '❌ Bekor qilish',
  'btn.back': '← Orqaga',
  'err.generic': "Nimadir xato ketdi. Birozdan keyin qayta urinib ko'ring.",
  'err.stale': "Bu amal endi dolzarb emas. Qaytadan boshlash uchun «Ish qo'shish» tugmasini bosing.",
  currency: "so'm",
  pcs: 'dona',
  'shop.factory': 'Fabrika',
  'shop.workshop': 'Sex',

  'w.noLink': "Botga kirish uchun ustadan taklif havolasi kerak. Ustadan so'rang.",
  'w.badLink': "Havola yaroqsiz yoki o'chirilgan. Ustadan yangi havola so'rang.",
  'w.rejected': "Arizangiz rad etilgan. Yangi ariza berish uchun ustadan yangi havola so'rang.",
  'w.pending': 'Ariza ustaga yuborilgan. Qarorni kuting — sizga xabar keladi.',
  'w.askName': 'Ism va familiyangizni yozing.',
  'w.badName': "Ism 2–40 ta harfdan iborat bo'lishi kerak. Qayta urinib ko'ring.",
  'w.submitted': "Rahmat, {name}! Ariza ustaga yuborildi. Ustadan javob kelgach, sizga xabar beramiz.",
  'w.approved': "✅ Usta arizangizni qabul qildi. Endi ish qo'shishingiz mumkin.",
  'w.rejectedNotice': "❌ Usta arizangizni rad etdi. Agar bu xato bo'lsa — ustadan yangi havola so'rang.",
  'w.removedNotice': "Siz botdan o'chirildingiz. Qayta kirish uchun ustadan yangi havola so'rang.",
  'w.notActive': "Siz botga ulanmagansiz. Ustadan taklif havolasini so'rang.",
  'w.noEmployee': "Usta sizni xodimlar ro'yxatiga hali bog'lamagan. Ustaga murojaat qiling.",
  'w.alreadyActive': 'Siz allaqachon ulangansiz. Menyudan amalni tanlang.',
  'w.isStaff': "Bu Telegram usta yoki direktor sifatida ulangan — bu yerda ishchi sifatida ishlab bo'lmaydi.",

  'menu.add': "➕ Ish qo'shish",
  'menu.stats': '📊 Mening statistikam',
  'menu.title': 'Amalni tanlang:',

  'add.noProfession': "Kasbingiz ko'rsatilmagan. Ustaga yozing — u tabelda ko'rsatadi.",
  'add.emptyCatalog': "Kasbingiz uchun katalogda narxi belgilangan amallar hali yo'q. Ustaga murojaat qiling.",
  'add.kind': 'Nima qildingiz?',
  'add.kindWhole': 'Butun buyum',
  'add.kindOp': 'Amal',
  'add.pickModel': 'Modelni tanlang:',
  'add.pickOp': '«{model}» modeli. Amalni tanlang:',
  'add.askQty': '{label}\nNecha dona? Butun son yozing.',
  'add.badQty': "1 dan 99999 gacha butun son kerak. Qayta urinib ko'ring.",
  'add.review': 'Yozuvni tekshiring:\n{label}\n{qty} dona × {rate} = <b>{total}</b>\nSana: {date}',
  'add.confirm': '✅ Tasdiqlash',
  'add.cancelled': 'Bekor qilindi, hech narsa saqlanmadi.',
  'add.saved':
    "✅ Saqlandi\n{label}\n{qty} dona × {rate} = <b>{total}</b>\nUsta yozuvni hali tasdiqlashi kerak — shu paytgacha u to'lovga kirmaydi.",
  'add.again': "➕ Yana qo'shish",
  'add.fix': "✏️ Yozuvlarni tuzatish",
  'add.gone': "Bu pozitsiya katalogda endi yo'q. Qaytadan boshlang.",
  'add.wholeSuffix': 'butun',

  'stats.pick': 'Qaysi davr uchun?',
  'stats.today': 'Bugun',
  'stats.week': 'Hafta',
  'stats.month': 'Oy',
  'stats.titleDay': '📊 <b>Bugun, {date}</b>',
  'stats.titleWeek': '📊 <b>Hafta: {from} – {to}</b>',
  'stats.titleMonth': '📊 <b>Oy: {from} – {to}</b>',
  'stats.confirmed': '✅ <b>Usta tasdiqlagan</b>',
  'stats.pending': '⏳ <b>Tasdiqlashni kutmoqda</b>',
  'stats.ops': 'Amallar:',
  'stats.whole': 'Butun buyumlar:',
  'stats.item': '• {label} — {qty} dona × {rate} = {sum}',
  'stats.sub': 'Jami: {qty} dona — <b>{sum}</b>',
  'stats.empty': "Bu davrda yozuvlar yo'q.",
  'stats.rejected': '❌ Usta rad etgan yozuvlar: {n}',
  'stats.compare': "↔️ O'tgan hafta shu davrda: {prev}. Bu hafta: {cur}. {diff}",
  'stats.up': "▲ ko'proq: {n}",
  'stats.down': '▼ kamroq: {n}',
  'stats.same': "o'zgarishsiz",
  'stats.fix': '✏️ Bugungi yozuvlarni tuzatish',

  'edit.title': 'Hali tuzatish mumkin bo‘lgan bugungi yozuvlar:',
  'edit.none':
    "Bugun tuzatish mumkin bo'lgan yozuvlar yo'q. Faqat o'zingizning bugungi yozuvlaringizni, usta tasdiqlamaguncha tuzatish mumkin.",
  'edit.card': '{label}\n{qty} dona × {rate} = <b>{total}</b>\nNima qilamiz?',
  'edit.btnQty': "✏️ Sonini o'zgartirish",
  'edit.btnDel': "🗑 O'chirish",
  'edit.askQty': "«{label}» uchun yangi son (hozir {qty} dona). Butun son yozing.",
  'edit.updated': '✅ Tuzatildi: {label}\n{qty} dona × {rate} = <b>{total}</b>',
  'edit.confirmDel': "«{label}» yozuvini, {qty} donani o'chiramizmi?",
  'edit.yesDel': "Ha, o'chirish",
  'edit.no': "Yo'q",
  'edit.deleted': "🗑 Yozuv o'chirildi.",
  'edit.locked': "Bu yozuvni endi tuzatib bo'lmaydi: usta tasdiqlagan yoki kun tugagan.",

  'role.master': 'usta',
  'role.ceo': 'direktor',
  's.hello': "Siz {role} sifatida ulangansiz. Ishchilarning botga kirish arizalari shu yerga keladi.\nTilni o'zgartirish: /lang",
  's.linked': '✅ Telegram hisobingizga ulandi ({role}). Ishchilar arizalari shu yerga keladi.',
  's.badCode': "Kod noto'g'ri yoki eskirgan. Saytda («Bot» bo'limi) yangi kod yarating.",
  's.alreadyLinked': "Bu Telegram boshqa hisobga ulangan. Avval saytda uzing.",
  's.isWorker': "Bu Telegram ishchi sifatida ro'yxatdan o'tgan. Usta uchun boshqa Telegram hisobi kerak.",
  's.request': '🆕 <b>Botga yangi ariza</b>\nIsm: {name}\nSex: {shop}\nKasb: {profession}',
  's.approve': '✅ Qabul qilish',
  's.reject': '❌ Rad etish',
  's.pickEmployee':
    "«{shop}» tabelidan kimni «{name}» ishchisiga bog'laymiz? Yoki yangi xodim yarating.",
  's.newEmployee': '➕ «{name}» xodimini yaratish',
  's.approved': '✅ Qabul qilindi: {name} → xodim «{employee}»',
  's.rejected': '❌ Rad etildi: {name}',
  's.alreadyDecided': 'Bu ariza allaqachon ko‘rib chiqilgan.',
  's.notYourShop': "Ariza boshqa sexdan. Avval saytda kerakli sexni tanlang.",
  's.nameTaken': "Tabelda bunday ismli xodim bor — uni ro'yxatdan tanlang.",
  's.employeeTaken': "Bu xodim boshqa ishchiga bog'langan.",
  's.stale': "Ro'yxat eskirgan — arizani qaytadan oching.",
  's.noProfession': "ko'rsatilmagan",
  's.notStaff': "Ruxsat yo'q.",
};

const DICTS: Record<Lang, Record<MessageKey, string>> = { ru, uz };

export function t(lang: Lang, key: MessageKey, params: Params = {}): string {
  return DICTS[lang][key].replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) return '';
    return value instanceof Raw ? value.html : esc(String(value));
  });
}

// Сообщение сразу на двух языках — когда язык ещё не выбран.
export function both(key: MessageKey, params: Params = {}): string {
  return `${t('ru', key, params)}\n${t('uz', key, params)}`;
}

export function isLang(value: unknown): value is Lang {
  return value === 'ru' || value === 'uz';
}

// Суммы — целые сум с точками-разделителями тысяч: 37.000.
export function money(value: number, lang: Lang): string {
  const n = Math.round(value);
  const sign = n < 0 ? '-' : '';
  const digits = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}${digits} ${t(lang, 'currency')}`;
}
