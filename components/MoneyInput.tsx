'use client';

import { useLayoutEffect, useRef } from 'react';
import { MAX_MONEY_DIGITS, formatDigits } from '@/lib/money';

// Единое поле ввода суммы в сумах — везде, где в программе вводятся деньги.
//
// Точка — разделитель тысяч, а не дробная часть: «37.000» = 37000. Поле
// само расставляет точки по мере набора (37.000, 5.000.000.000), точку
// можно ставить и вручную — она ничего не ломает. Суммы только целые, без
// копеек. value и onChange работают со СТРОКОЙ ЦИФР без разделителей
// («37000»), поэтому вызывающий код считает деньги как раньше —
// Number(value).
//
// type="text" + inputMode="numeric": на телефоне открывается цифровая
// клавиатура и нет стрелочек «вверх-вниз», которые есть у type="number".
export default function MoneyInput({
  value,
  onChange,
  className = 'input',
  ...rest
}: {
  value: string;
  onChange: (digits: string) => void;
  className?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'inputMode' | 'className'>) {
  const ref = useRef<HTMLInputElement>(null);
  // Сколько цифр было слева от курсора после ввода — чтобы после
  // переформатирования (появились/пропали точки) курсор не прыгал в конец.
  const digitsBeforeCaret = useRef<number | null>(null);

  const display = formatDigits(value);

  useLayoutEffect(() => {
    const el = ref.current;
    const n = digitsBeforeCaret.current;
    if (!el || n === null || document.activeElement !== el) {
      digitsBeforeCaret.current = null;
      return;
    }
    let pos = 0;
    if (n > 0) {
      let seen = 0;
      for (pos = 0; pos < display.length; pos++) {
        if (/\d/.test(display[pos])) seen++;
        if (seen === n) {
          pos++;
          break;
        }
      }
    }
    el.setSelectionRange(pos, pos);
    digitsBeforeCaret.current = null;
  });

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value;
    const caret = e.target.selectionStart ?? raw.length;
    const before = raw.slice(0, caret).replace(/\D/g, '').length;
    let digits = raw.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
    if (digits.length > MAX_MONEY_DIGITS) digits = digits.slice(0, MAX_MONEY_DIGITS);
    digitsBeforeCaret.current = Math.min(before, digits.length);
    onChange(digits);
  }

  return (
    <input
      ref={ref}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      className={className}
      value={display}
      onChange={handleChange}
      {...rest}
    />
  );
}
