/** @type {import('tailwindcss').Config} */

// Цвета берутся из переменных в app/globals.css (:root) — палитра
// меняется там одной правкой. Оттенки считаются от базовых цветов
// через color-mix, поэтому «тинт» красного/зелёного/жёлтого/акцента
// всегда согласован с базовым.
const tint = (v, pct) => `color-mix(in srgb, var(--${v}) ${pct}%, white)`;
const shade = (v, pct) => `color-mix(in srgb, var(--${v}) ${100 - pct}%, black)`;

const scale = (v) => ({
  DEFAULT: `var(--${v})`,
  50: tint(v, 8),
  100: tint(v, 15),
  200: tint(v, 28),
  300: tint(v, 45),
  400: tint(v, 70),
  500: tint(v, 88),
  600: `var(--${v})`,
  700: shade(v, 14),
  800: shade(v, 28),
  900: shade(v, 42),
});

module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: 'var(--brand)',
          muted: 'var(--nav-muted)',
          active: 'var(--nav-active)',
          // подсветка строки меню на тёмном фоне
          hover: 'color-mix(in srgb, var(--nav-active) 8%, var(--brand))',
          line: 'color-mix(in srgb, var(--nav-active) 14%, var(--brand))',
        },
        accent: scale('accent'),
        danger: scale('danger'),
        success: scale('success'),
        warning: scale('warning'),
        // Нейтральная шкала. Заменяет стандартную slate: фон страниц,
        // границы, второстепенный текст (500) и заголовки (900) берутся
        // из палитры, чтобы серые не расходились с основным цветом.
        slate: {
          50: 'var(--page)',
          100: 'color-mix(in srgb, var(--brand) 7%, white)',
          200: 'color-mix(in srgb, var(--brand) 13%, white)',
          300: 'color-mix(in srgb, var(--brand) 24%, white)',
          400: 'color-mix(in srgb, var(--text-secondary) 62%, white)',
          500: 'var(--text-secondary)',
          600: 'color-mix(in srgb, var(--text-secondary) 78%, var(--brand))',
          700: 'color-mix(in srgb, var(--text-secondary) 45%, var(--brand))',
          800: 'color-mix(in srgb, var(--brand) 90%, white)',
          900: 'var(--brand)',
        },
      },
    },
  },
  plugins: [],
};
