import { escapeHtml } from '@/lib/telegram';

// Все тексты Telegram-бота на двух языках в одном месте. Словарь uz
// объявлен как «те же ключи, что у ru» — если строка не переведена,
// проект не соберётся. Названия товаров, цветов, размеров, имена клиентов
// и кладовщика — данные, они подставляются как есть и не переводятся.
//
// Значения-параметры экранируются автоматически (сообщения уходят с
// parse_mode HTML); уже готовый HTML передаётся через raw().

export type Lang = 'ru' | 'uz';

class Raw {
  readonly html: string;
  constructor(html: string) {
    this.html = html;
  }
}
export const raw = (html: string) => new Raw(html);

export type Params = Record<string, string | number | Raw>;

const ru = {
  // --- общее
  pcs: 'шт',
  'btn.cancel': 'Отмена',
  help:
    'Доступные команды:\n' +
    '/sklad — просмотр склада\n' +
    '/add_product — добавить товар на склад\n' +
    '/new_order — выдать заказ клиенту (списание сразу)\n' +
    '/history_orders — история выданных заказов\n' +
    '/cancel — отменить текущее действие',
  welcome: 'Добро пожаловать, {name}! Вход выполнен на 24 часа.\n\n{help}',
  unknownCommand: 'Неизвестная команда.\n\n{help}',
  noActiveAction: 'Нет активного действия.\n\n{help}',
  cancelled: 'Текущее действие отменено, ничего не списано.',
  pickFirst: 'Сначала выберите вариант из списка выше (или /cancel).',
  noActiveChoice: 'Нет активного выбора.',
  staleAction: 'Это действие уже неактуально.',
  unknownChoice: 'Неизвестный выбор.',
  startOrder: 'Наберите /new_order, чтобы начать заказ.',
  prevCancelled: 'Предыдущее незавершённое действие отменено.\n\n',

  // --- вход: PIN, язык, имя (сообщения PIN показываются на двух языках сразу)
  'pin.prompt': 'Введите PIN-код.',
  'pin.expiredDraft': 'Сессия истекла. Введите PIN-код — ваше незавершённое действие сохранено.',
  'resume.notice': 'У вас есть незавершённое действие — продолжаем с того места, где остановились (отмена — /cancel).',
  'pin.wrong': 'Неверный PIN (попытка {attempts}/{max}).',
  'pin.wrongLocked': 'Неверный PIN. Слишком много попыток — попробуйте снова через {minutes} мин.',
  'pin.locked': 'Слишком много неверных попыток. Попробуйте снова через {minutes} мин.',
  'pin.notSet': 'Бот не настроен (не задан PIN). Обратитесь к администратору.',
  sessionExpired: 'Сессия истекла. Введите PIN заново.',
  notConfigured: 'Бот временно не настроен. Обратитесь к администратору.',
  'name.ask': 'Введите ваше имя (оно будет видно в истории выдачи).',
  'name.invalid': 'Имя должно состоять из 2–40 букв (без цифр и символов). Попробуйте ещё раз.',

  // --- /sklad
  'sklad.title': '<b>Склад — готовая продукция</b>\nВыберите товар:',
  'sklad.empty': 'На складе готовой продукции пока нет товаров.',
  'sklad.chooseColor': '<b>{product}</b>\nВыберите цвет:',
  'sklad.notFound': 'Этот товар не найден на складе.',
  'sklad.color': '<b>{product}, {color}</b>\n{lines}\n\nВсего: {total} шт\n⚠️ — мало, ❌ — нет в наличии',
  'sklad.line': '{size} — {qty} шт',
  'sklad.noSize': 'Без размера',
  'sklad.noColor': 'Без цвета',
  'btn.toProducts': '← К товарам',
  'btn.toColors': '← К цветам',

  // --- /new_order
  'order.start':
    'Новый заказ — товар выдаётся клиенту сразу, остаток спишется при выдаче.\nВведите имя или телефон клиента.',
  'order.itemsHelp':
    'Что нужно клиенту? Пишите свободным текстом, например:\n<i>футболка черный xl 50 штук</i>\n' +
    'Можно несколько позиций — по одной в строке. Когда всё добавлено, нажмите «Выдать заказ» (или /confirm). Отмена — /cancel.',
  'order.enterClient': 'Введите имя или телефон клиента.',
  'order.clientNotFound': 'Клиент «{query}» не найден.',
  'order.clientsFound': 'Найдены клиенты:',
  'order.newClientBtn': 'Создать нового клиента',
  'order.askNewName': 'Введите имя нового клиента.',
  'order.askNewPhone': 'Введите телефон нового клиента (или «-», чтобы пропустить).',
  'order.clientCreateFailed': 'Не удалось создать клиента. Попробуйте ещё раз.',
  'order.reenterClient': 'Ок, введите имя или телефон клиента ещё раз.',
  'order.clientPickFailed': 'Не удалось выбрать клиента.',
  'order.variantPickFailed': 'Не удалось выбрать вариант.',
  'order.clientSelected': 'Клиент: {client}.\n\n{help}',
  'order.clientCreated': 'Клиент создан: {client}.\n\n{help}',
  'order.noStock': '❌ {title}: нет в наличии{note}.',
  'order.noStockNote': ' (весь остаток — {stock} шт — уже в этом заказе)',
  'order.qtyPrompt': '⚠️ {title}: запрошено {requested} шт.\nВ наличии только {available} шт{note}. Сколько забрать?{fix}',
  'order.qtyConfirm': '📦 {title}: на складе {available} шт{note}. Взять {requested}?{fix}',
  'order.qtyNote': ' (ещё {already} шт. уже добавлено в заказ)',
  'order.take': 'Взять {n} шт',
  'order.takeAll': 'Забрать {n} шт',
  'order.skipItem': 'Пропустить позицию',
  'order.added': '✅ Добавлено: {title} — {qty} шт (остаток {stock}).{fix}',
  'order.fixed': '\n✏️ Исправлено: {pairs}',
  'order.summary':
    '<b>Клиент:</b> {client}\n<b>Заказ (будет выдан сразу):</b>\n{lines}\n\nДобавьте ещё позицию текстом или нажмите «Выдать заказ».',
  'order.summaryEmpty': 'В заказе пока нет позиций.\n\n{help}',
  'order.issueBtn': '✅ Выдать заказ',
  'order.pickVariant': 'Уточните вариант для «{line}»:{note}',
  'order.truncated': '\nПоказаны первые {shown} из {total} — уточните цвет и размер.',
  'order.noQtyPending': 'Нет позиции, ожидающей количества.',
  'order.skipped': 'Позиция пропущена.',
  'order.noStockLeft': '❌ {title}: остатка не осталось, позиция пропущена.',
  'order.qtyTooMany': 'В наличии только {available} шт. Введите количество не больше {available} или нажмите «Пропустить».',
  'order.qtyNotNumber': 'Введите число (сколько забрать) или нажмите кнопку «Пропустить позицию».',
  'order.empty': 'Нечего выдавать — заказ пуст. Начните с /new_order.',
  'order.finishChoice': 'Сначала завершите выбор выше: укажите количество или выберите вариант (или /cancel).',
  'order.alreadyDone': 'Этот заказ уже оформлен или отменён.',
  'order.summaryChanged': 'Заказ изменился с тех пор, как был показан тот итог. Вот актуальный:',
  'order.phoneExists': 'Клиент с таким телефоном уже есть: {client}. Использовать его?',
  'order.useExistingBtn': 'Использовать «{name}»',
  'order.createAnywayBtn': 'Всё равно создать нового',
  'order.stockChanged':
    'Остаток изменился, пока вы оформляли заказ:\n{adjustments}\n\nЗаказ ещё НЕ выдан — проверьте и подтвердите заново.',
  'order.adjReduced': '• {title}: было {was}, осталось {left} — количество уменьшено',
  'order.adjRemoved': '• {title}: остатка нет — позиция убрана',
  'order.createFailed': 'Не удалось создать заказ. Заказ сохранён — попробуйте нажать «Выдать заказ» ещё раз.',
  'order.itemsFailed': 'Не удалось сохранить позиции. Заказ не создан и не выдан — попробуйте «Выдать заказ» ещё раз.',
  'order.raceFailed': 'Остаток изменился в последний момент — заказ НЕ выдан. Проверьте позиции и нажмите «Выдать заказ» ещё раз.',
  'order.issueFailed': 'Не удалось выдать заказ. Ничего не списано — попробуйте ещё раз.',
  'order.issued': '<b>Заказ выдан ✅</b>\nКлиент: {client}\nВыдал: {staff}\nСтатус: Выдан, остаток списан.\n{lines}\n\n{url}',
  'order.issuedLine': '• {title} — {qty} шт (остаток теперь {left})',
  'order.cancelled': 'Заказ отменён, ничего не списано.',

  // --- /add_product
  'ap.start':
    '<b>Добавление товара на склад</b> (без печати)\nШаг 1/4. Выберите товар из списка или введите название нового.',
  'ap.color': 'Товар: <b>{name}</b>{isNew}\nШаг 2/4. Выберите цвет или введите новый.',
  'ap.new': ' (новый)',
  'ap.size': 'Цвет: <b>{color}</b>\nШаг 3/4. Выберите размер или введите новый.',
  'ap.noColorLabel': 'без цвета',
  'ap.qty': 'Размер: <b>{size}</b>\nШаг 4/4. Введите количество (шт).',
  'ap.noSizeLabel': 'без размера',
  'ap.noColorBtn': 'Без цвета',
  'ap.noSizeBtn': 'Без размера',
  'ap.missingData': 'Не хватает данных. Начните заново: /add_product.',
  'ap.createProductFailed': 'Не удалось создать товар. Введите количество ещё раз или /cancel.',
  'ap.saveFailed': 'Не удалось сохранить товар. Введите количество ещё раз или /cancel.',
  'ap.raced': 'Остаток менялся во время сохранения. Введите количество ещё раз или /cancel.',
  'ap.doneNew': 'Товар успешно добавлен на склад ✅\n{title}: {qty} шт.',
  'ap.doneExisting':
    'Товар успешно добавлен на склад ✅\n{title}\nТакой вариант уже был, остаток стал {after} (было {before}, +{added}).',
  'ap.qtyInvalid': 'Введите количество числом больше нуля, например: 20',
  'ap.startOver': 'Наберите /add_product, чтобы начать.',
  'ap.stale': 'Это действие уже неактуально. Начните заново: /add_product.',
  'ap.pickFailed': 'Не удалось выбрать. Начните заново: /add_product.',
  'ap.staleStep': 'Это действие уже неактуально. Продолжите текущий шаг или /cancel.',
  'ap.similarName': 'Товара «{typed}» на складе нет. Возможно, вы имели в виду уже существующий?',
  'ap.similarColor': 'Цвета «{typed}» в списке нет. Возможно, вы имели в виду существующий?',
  'ap.createNewBtn': 'Нет, создать новый «{typed}»',
  'ap.confirm': '<b>Добавить на склад?</b>\n{title}: {qty} шт{flags}{stock}\n\nМожно написать другое количество.',
  'ap.flagNewProduct': '\n⚠️ новый товар',
  'ap.flagNewColor': '\n⚠️ новый цвет',
  'ap.flagNewSize': '\n⚠️ новый размер',
  'ap.stockChange': '\nСейчас {before} → станет {after}',
  'ap.saveBtn': '✅ Сохранить',
  'ap.cancelled': 'Добавление отменено, ничего не сохранено.',
  'ap.confirmHint': 'Нажмите «Сохранить» или «Отмена», либо напишите другое количество.',

  // --- /history_orders
  'history.title': '<b>Последние выданные заказы</b> ({n})',
  'history.empty': 'Выданных заказов пока нет.',
  'history.error': 'Не удалось загрузить историю. Попробуйте ещё раз.',
  'history.by': ' · выдал {name}',
  'history.noItems': '  (позиции не выданы)',
  'history.more': '  …и ещё {n} поз.',
  'history.client': 'Клиент',
  'history.product': 'Товар',

  // --- ошибки разбора строки заказа
  'parse.noTokens': 'Не указан товар: «{line}»',
  'parse.badQty': 'Количество должно быть больше нуля: «{line}»',
  'parse.noProduct': 'Товар не найден: «{line}». На складе: {products}.',
  'parse.unrecognized': 'Не удалось распознать «{tokens}» в строке «{line}». У «{product}» цвета: {colors}; размеры: {sizes}.',
  'parse.noVariant': 'Такого варианта нет: «{line}». У «{product}» цвета: {colors}; размеры: {sizes}.',
} as const;

export type MessageKey = keyof typeof ru;

const uz: Record<MessageKey, string> = {
  // --- umumiy
  pcs: 'dona',
  'btn.cancel': 'Bekor qilish',
  help:
    'Mavjud buyruqlar:\n' +
    "/sklad — omborni ko'rish\n" +
    "/add_product — omborga tovar qo'shish\n" +
    "/new_order — mijozga buyurtma berish (qoldiq darhol yechiladi)\n" +
    '/history_orders — berilgan buyurtmalar tarixi\n' +
    '/cancel — joriy amalni bekor qilish',
  welcome: 'Xush kelibsiz, {name}! Kirish 24 soatga amalga oshirildi.\n\n{help}',
  unknownCommand: "Noma'lum buyruq.\n\n{help}",
  noActiveAction: "Faol amal yo'q.\n\n{help}",
  cancelled: 'Joriy amal bekor qilindi, hech narsa yechilmadi.',
  pickFirst: "Avval yuqoridagi ro'yxatdan variantni tanlang (yoki /cancel).",
  noActiveChoice: "Faol tanlov yo'q.",
  staleAction: 'Bu amal endi dolzarb emas.',
  unknownChoice: "Noma'lum tanlov.",
  startOrder: 'Buyurtmani boshlash uchun /new_order buyrug\'ini yuboring.',
  prevCancelled: 'Oldingi tugallanmagan amal bekor qilindi.\n\n',

  // --- kirish: PIN, til, ism
  'pin.prompt': 'PIN kodini kiriting.',
  'pin.expiredDraft': 'Sessiya tugadi. PIN kodini kiriting — tugallanmagan amalingiz saqlangan.',
  'resume.notice': "Sizda tugallanmagan amal bor — to'xtagan joyingizdan davom etamiz (bekor qilish — /cancel).",
  'pin.wrong': "PIN noto'g'ri ({attempts}/{max}-urinish).",
  'pin.wrongLocked': "PIN noto'g'ri. Urinishlar juda ko'p — {minutes} daqiqadan keyin qayta urinib ko'ring.",
  'pin.locked': "Noto'g'ri urinishlar juda ko'p. {minutes} daqiqadan keyin qayta urinib ko'ring.",
  'pin.notSet': "Bot sozlanmagan (PIN belgilanmagan). Administratorga murojaat qiling.",
  sessionExpired: 'Sessiya tugadi. PIN kodini qaytadan kiriting.',
  notConfigured: 'Bot vaqtincha sozlanmagan. Administratorga murojaat qiling.',
  'name.ask': "Ismingizni kiriting (u berish tarixida ko'rinadi).",
  'name.invalid': "Ism 2 dan 40 gacha harfdan iborat bo'lishi kerak (raqam va belgilarsiz). Qayta urinib ko'ring.",

  // --- /sklad
  'sklad.title': '<b>Ombor — tayyor mahsulot</b>\nTovarni tanlang:',
  'sklad.empty': "Tayyor mahsulot omborida hozircha tovar yo'q.",
  'sklad.chooseColor': '<b>{product}</b>\nRangni tanlang:',
  'sklad.notFound': 'Bu tovar omborda topilmadi.',
  'sklad.color': '<b>{product}, {color}</b>\n{lines}\n\nJami: {total} dona\n⚠️ — kam qolgan, ❌ — mavjud emas',
  'sklad.line': '{size} — {qty} dona',
  'sklad.noSize': "O'lchamsiz",
  'sklad.noColor': 'Rangsiz',
  'btn.toProducts': '← Tovarlarga',
  'btn.toColors': '← Ranglarga',

  // --- /new_order
  'order.start':
    "Yangi buyurtma — tovar mijozga darhol beriladi, qoldiq berilganda yechiladi.\nMijozning ismi yoki telefon raqamini kiriting.",
  'order.itemsHelp':
    "Mijozga nima kerak? Erkin matnda yozing, masalan:\n<i>mayka qora xl 50 ta</i>\n" +
    "Bir nechta pozitsiya bo'lishi mumkin — har qatorda bittadan. Hammasi qo'shilgach, «Buyurtmani topshirish» tugmasini bosing (yoki /confirm). Bekor qilish — /cancel.",
  'order.enterClient': 'Mijozning ismi yoki telefon raqamini kiriting.',
  'order.clientNotFound': '«{query}» mijozi topilmadi.',
  'order.clientsFound': 'Topilgan mijozlar:',
  'order.newClientBtn': 'Yangi mijoz yaratish',
  'order.askNewName': 'Yangi mijozning ismini kiriting.',
  'order.askNewPhone': "Yangi mijozning telefon raqamini kiriting (o'tkazib yuborish uchun «-»).",
  'order.clientCreateFailed': "Mijozni yaratib bo'lmadi. Qayta urinib ko'ring.",
  'order.reenterClient': 'Xo\'p, mijozning ismi yoki telefon raqamini qaytadan kiriting.',
  'order.clientPickFailed': "Mijozni tanlab bo'lmadi.",
  'order.variantPickFailed': "Variantni tanlab bo'lmadi.",
  'order.clientSelected': 'Mijoz: {client}.\n\n{help}',
  'order.clientCreated': 'Mijoz yaratildi: {client}.\n\n{help}',
  'order.noStock': '❌ {title}: mavjud emas{note}.',
  'order.noStockNote': ' (butun qoldiq — {stock} dona — allaqachon shu buyurtmada)',
  'order.qtyPrompt': "⚠️ {title}: {requested} dona so'raldi.\nOmborda faqat {available} dona bor{note}. Nechta olinadi?{fix}",
  'order.qtyConfirm': '📦 {title}: omborda {available} dona bor{note}. {requested} dona olinsinmi?{fix}',
  'order.qtyNote': " (yana {already} dona buyurtmaga qo'shilgan)",
  'order.take': '{n} dona olish',
  'order.takeAll': '{n} dona olish',
  'order.skipItem': "Pozitsiyani o'tkazib yuborish",
  'order.added': "✅ Qo'shildi: {title} — {qty} dona (qoldiq {stock}).{fix}",
  'order.fixed': '\n✏️ Tuzatildi: {pairs}',
  'order.summary':
    "<b>Mijoz:</b> {client}\n<b>Buyurtma (darhol topshiriladi):</b>\n{lines}\n\nYana pozitsiya qo'shing yoki «Buyurtmani topshirish» tugmasini bosing.",
  'order.summaryEmpty': "Buyurtmada hozircha pozitsiya yo'q.\n\n{help}",
  'order.issueBtn': '✅ Buyurtmani topshirish',
  'order.pickVariant': "«{line}» uchun variantni aniqlang:{note}",
  'order.truncated': "\n{total} tadan dastlabki {shown} tasi ko'rsatildi — rang va o'lchamni aniqroq yozing.",
  'order.noQtyPending': "Miqdor kutayotgan pozitsiya yo'q.",
  'order.skipped': "Pozitsiya o'tkazib yuborildi.",
  'order.noStockLeft': "❌ {title}: qoldiq qolmadi, pozitsiya o'tkazib yuborildi.",
  'order.qtyTooMany': "Omborda faqat {available} dona bor. {available} dan oshmagan miqdorni kiriting yoki «O'tkazib yuborish» tugmasini bosing.",
  'order.qtyNotNumber': "Raqam kiriting (nechta olinadi) yoki «Pozitsiyani o'tkazib yuborish» tugmasini bosing.",
  'order.empty': "Topshiradigan narsa yo'q — buyurtma bo'sh. /new_order dan boshlang.",
  'order.finishChoice': "Avval yuqoridagi tanlovni yakunlang: miqdorni kiriting yoki variantni tanlang (yoki /cancel).",
  'order.alreadyDone': 'Bu buyurtma allaqachon rasmiylashtirilgan yoki bekor qilingan.',
  'order.summaryChanged': "Bu jamlanma ko'rsatilgandan keyin buyurtma o'zgardi. Mana joriy holati:",
  'order.phoneExists': 'Bunday telefon raqamli mijoz allaqachon bor: {client}. Shuni ishlatamizmi?',
  'order.useExistingBtn': '«{name}» ni ishlatish',
  'order.createAnywayBtn': 'Baribir yangisini yaratish',
  'order.stockChanged':
    "Buyurtmani rasmiylashtirayotganingizda qoldiq o'zgardi:\n{adjustments}\n\nBuyurtma HALI topshirilmagan — tekshirib, qaytadan tasdiqlang.",
  'order.adjReduced': '• {title}: {was} edi, {left} qoldi — miqdor kamaytirildi',
  'order.adjRemoved': "• {title}: qoldiq yo'q — pozitsiya olib tashlandi",
  'order.createFailed': "Buyurtmani yaratib bo'lmadi. Buyurtma saqlangan — «Buyurtmani topshirish» tugmasini yana bosib ko'ring.",
  'order.itemsFailed': "Pozitsiyalarni saqlab bo'lmadi. Buyurtma yaratilmadi va topshirilmadi — «Buyurtmani topshirish» tugmasini yana bosib ko'ring.",
  'order.raceFailed': "Qoldiq oxirgi daqiqada o'zgardi — buyurtma topshirilMADI. Pozitsiyalarni tekshirib, «Buyurtmani topshirish» tugmasini yana bosing.",
  'order.issueFailed': "Buyurtmani topshirib bo'lmadi. Hech narsa yechilmadi — qayta urinib ko'ring.",
  'order.issued': '<b>Buyurtma topshirildi ✅</b>\nMijoz: {client}\nTopshirdi: {staff}\nHolat: Topshirilgan, qoldiq yechildi.\n{lines}\n\n{url}',
  'order.issuedLine': '• {title} — {qty} dona (hozirgi qoldiq {left})',
  'order.cancelled': 'Buyurtma bekor qilindi, hech narsa yechilmadi.',

  // --- /add_product
  'ap.start':
    "<b>Omborga tovar qo'shish</b> (bosmasiz)\n1/4-qadam. Ro'yxatdan tovarni tanlang yoki yangisining nomini kiriting.",
  'ap.color': 'Tovar: <b>{name}</b>{isNew}\n2/4-qadam. Rangni tanlang yoki yangisini kiriting.',
  'ap.new': ' (yangi)',
  'ap.size': "Rang: <b>{color}</b>\n3/4-qadam. O'lchamni tanlang yoki yangisini kiriting.",
  'ap.noColorLabel': 'rangsiz',
  'ap.qty': "O'lcham: <b>{size}</b>\n4/4-qadam. Miqdorni kiriting (dona).",
  'ap.noSizeLabel': "o'lchamsiz",
  'ap.noColorBtn': 'Rangsiz',
  'ap.noSizeBtn': "O'lchamsiz",
  'ap.missingData': "Ma'lumot yetarli emas. Qaytadan boshlang: /add_product.",
  'ap.createProductFailed': "Tovarni yaratib bo'lmadi. Miqdorni qayta kiriting yoki /cancel.",
  'ap.saveFailed': "Tovarni saqlab bo'lmadi. Miqdorni qayta kiriting yoki /cancel.",
  'ap.raced': "Saqlash vaqtida qoldiq o'zgardi. Miqdorni qayta kiriting yoki /cancel.",
  'ap.doneNew': "Tovar omborga muvaffaqiyatli qo'shildi ✅\n{title}: {qty} dona.",
  'ap.doneExisting':
    "Tovar omborga muvaffaqiyatli qo'shildi ✅\n{title}\nBunday variant avvaldan bor edi, qoldiq {after} bo'ldi ({before} edi, +{added}).",
  'ap.qtyInvalid': "Miqdorni noldan katta son bilan kiriting, masalan: 20",
  'ap.startOver': "Boshlash uchun /add_product buyrug'ini yuboring.",
  'ap.stale': "Bu amal endi dolzarb emas. Qaytadan boshlang: /add_product.",
  'ap.pickFailed': "Tanlab bo'lmadi. Qaytadan boshlang: /add_product.",
  'ap.staleStep': 'Bu amal endi dolzarb emas. Joriy qadamni davom ettiring yoki /cancel.',
  'ap.similarName': "«{typed}» nomli tovar omborda yo'q. Balki mavjud tovarni nazarda tutgandirsiz?",
  'ap.similarColor': "«{typed}» rangi ro'yxatda yo'q. Balki mavjud rangni nazarda tutgandirsiz?",
  'ap.createNewBtn': "Yo'q, yangi «{typed}» yaratish",
  'ap.confirm': "<b>Omborga qo'shamizmi?</b>\n{title}: {qty} dona{flags}{stock}\n\nBoshqa miqdorni yozish mumkin.",
  'ap.flagNewProduct': '\n⚠️ yangi tovar',
  'ap.flagNewColor': '\n⚠️ yangi rang',
  'ap.flagNewSize': "\n⚠️ yangi o'lcham",
  'ap.stockChange': "\nHozir {before} → {after} bo'ladi",
  'ap.saveBtn': '✅ Saqlash',
  'ap.cancelled': "Qo'shish bekor qilindi, hech narsa saqlanmadi.",
  'ap.confirmHint': "«Saqlash» yoki «Bekor qilish» tugmasini bosing, yoki boshqa miqdorni yozing.",

  // --- /history_orders
  'history.title': '<b>Oxirgi berilgan buyurtmalar</b> ({n})',
  'history.empty': "Berilgan buyurtmalar hozircha yo'q.",
  'history.error': "Tarixni yuklab bo'lmadi. Qayta urinib ko'ring.",
  'history.by': ' · topshirgan: {name}',
  'history.noItems': '  (pozitsiyalar berilmagan)',
  'history.more': '  …yana {n} ta pozitsiya',
  'history.client': 'Mijoz',
  'history.product': 'Tovar',

  // --- buyurtma qatorini tahlil qilish xatolari
  'parse.noTokens': "Tovar ko'rsatilmagan: «{line}»",
  'parse.badQty': "Miqdor noldan katta bo'lishi kerak: «{line}»",
  'parse.noProduct': 'Tovar topilmadi: «{line}». Omborda: {products}.',
  'parse.unrecognized': "«{line}» qatoridagi «{tokens}» tanilmadi. «{product}» ranglari: {colors}; o'lchamlari: {sizes}.",
  'parse.noVariant': "Bunday variant yo'q: «{line}». «{product}» ranglari: {colors}; o'lchamlari: {sizes}.",
};

const DICTS: Record<Lang, Record<MessageKey, string>> = { ru, uz };

export function t(lang: Lang, key: MessageKey, params: Params = {}): string {
  return DICTS[lang][key].replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) return '';
    return value instanceof Raw ? value.html : escapeHtml(String(value));
  });
}

// Сообщение сразу на двух языках — для случаев, когда язык ещё не выбран
// (запрос PIN, выбор языка).
export function both(key: MessageKey, params: Params = {}): string {
  return `${t('ru', key, params)}\n${t('uz', key, params)}`;
}
