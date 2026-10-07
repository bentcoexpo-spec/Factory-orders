'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { CatalogData, loadCatalog } from '@/lib/catalog';
import { friendlyCatalogError } from '@/lib/errors';
import { formatMoney } from '@/lib/format';
import { moneyDigits } from '@/lib/money';
import MoneyInput from '@/components/MoneyInput';
import { CatalogModel, CatalogOperation, Profession } from '@/lib/types';

type View = { level: 'professions' } | { level: 'models'; professionId: string } | { level: 'operations'; modelId: string };
type Kind = 'profession' | 'model' | 'operation';

interface Editing {
  kind: Kind;
  id: string;
  value: string;
}

// Строка названия с переименованием на месте. Вынесена из CatalogEditor:
// вложенный компонент пересоздавался бы при каждом нажатии клавиши и
// сбрасывал бы фокус поля.
function NameRow({
  kind,
  id,
  name,
  editing,
  setEditing,
  busy,
  onSave,
  children,
}: {
  kind: Kind;
  id: string;
  name: string;
  editing: Editing | null;
  setEditing: (e: Editing | null) => void;
  busy: boolean;
  onSave: () => void;
  children: React.ReactNode;
}) {
  if (editing && editing.kind === kind && editing.id === id) {
    return (
      <div className="space-y-2">
        <input autoFocus className="input" value={editing.value} onChange={(e) => setEditing({ ...editing, value: e.target.value })} />
        <div className="flex gap-2">
          <button type="button" disabled={busy} onClick={onSave} className="btn-primary btn-sm">
            Сохранить
          </button>
          <button type="button" onClick={() => setEditing(null)} className="btn-ghost-muted">
            Отмена
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0 flex-1">{children}</div>
      <button type="button" onClick={() => setEditing({ kind, id, value: name })} className="btn-ghost shrink-0">
        Переименовать
      </button>
    </div>
  );
}

// Каталог расценок сделки: профессии → модели → операции с расценкой за
// штуку; у модели ещё может быть цена «целого изделия». Общий для обоих
// цехов. Цена в записях фиксируется в момент внесения — смена цены здесь
// старые записи не меняет.
export default function CatalogEditor() {
  const [data, setData] = useState<CatalogData>({ professions: [], models: [], operations: [] });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState<View>({ level: 'professions' });

  const [newName, setNewName] = useState('');
  const [newRate, setNewRate] = useState('');
  const [editing, setEditing] = useState<Editing | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [moving, setMoving] = useState<{ kind: 'model' | 'operation'; id: string; professionId: string; modelId: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function reload() {
    try {
      const next = await loadCatalog();
      setData(next);
      const d: Record<string, string> = {};
      next.models.forEach((m) => (d[`whole:${m.id}`] = moneyDigits(m.whole_rate)));
      next.operations.forEach((o) => (d[`op:${o.id}`] = moneyDigits(o.rate_per_piece)));
      setDrafts(d);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setLoaded(true);
  }

  useEffect(() => {
    reload();
  }, []);

  const profession = view.level === 'models' ? data.professions.find((p) => p.id === view.professionId) : undefined;
  const model = view.level === 'operations' ? data.models.find((m) => m.id === view.modelId) : undefined;
  const modelProfession = model ? data.professions.find((p) => p.id === model.profession_id) : undefined;

  const modelsOf = useMemo(() => {
    const map = new Map<string, CatalogModel[]>();
    data.models.forEach((m) => map.set(m.profession_id, [...(map.get(m.profession_id) ?? []), m]));
    return map;
  }, [data.models]);
  const opsOf = useMemo(() => {
    const map = new Map<string, CatalogOperation[]>();
    data.operations.forEach((o) => map.set(o.model_id, [...(map.get(o.model_id) ?? []), o]));
    return map;
  }, [data.operations]);

  function go(next: View) {
    setView(next);
    setNewName('');
    setNewRate('');
    setEditing(null);
    setMoving(null);
    setNotice(null);
    setError(null);
  }

  async function run(action: () => PromiseLike<{ error: { message: string } | null }>, okNote?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const { error: e } = await action();
    setBusy(false);
    if (e) {
      setError(friendlyCatalogError(e.message));
      return false;
    }
    if (okNote) setNotice(okNote);
    await reload();
    return true;
  }

  async function addItem() {
    const name = newName.trim();
    if (!name) {
      setError('Введите название');
      return;
    }
    if (view.level === 'professions') {
      if (await run(() => supabase.from('professions').insert({ name }))) setNewName('');
    } else if (view.level === 'models') {
      const whole = newRate ? Number(newRate) : null;
      if (await run(() => supabase.from('catalog_models').insert({ profession_id: view.professionId, name, whole_rate: whole }))) {
        setNewName('');
        setNewRate('');
      }
    } else {
      if (await run(() => supabase.from('catalog_operations').insert({ model_id: view.modelId, name, rate_per_piece: Number(newRate || 0) }))) {
        setNewName('');
        setNewRate('');
      }
    }
  }

  async function saveRename() {
    if (!editing) return;
    const name = editing.value.trim();
    if (!name) {
      setError('Введите название');
      return;
    }
    const table = editing.kind === 'profession' ? 'professions' : editing.kind === 'model' ? 'catalog_models' : 'catalog_operations';
    if (await run(() => supabase.from(table).update({ name }).eq('id', editing.id))) setEditing(null);
  }

  async function saveOperationRate(op: CatalogOperation) {
    const value = Number(drafts[`op:${op.id}`] || 0);
    if (Number(op.rate_per_piece) === value) return;
    await run(() => supabase.from('catalog_operations').update({ rate_per_piece: value }).eq('id', op.id));
  }

  async function saveWholeRate(m: CatalogModel) {
    const digits = drafts[`whole:${m.id}`] ?? '';
    const value = digits === '' ? null : Number(digits);
    if ((m.whole_rate === null ? null : Number(m.whole_rate)) === value) return;
    await run(() => supabase.from('catalog_models').update({ whole_rate: value }).eq('id', m.id));
  }

  async function removeItem(kind: Kind, id: string, name: string) {
    const what = kind === 'profession' ? 'профессию' : kind === 'model' ? 'модель' : 'операцию';
    if (
      !confirm(
        `Удалить ${what} «${name}»?\nЕсли по ней уже были записи сделки, она будет скрыта из выбора, а старые записи, суммы и названия останутся.`
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    const { data: result, error: e } = await supabase.rpc('remove_catalog_item', { p_kind: kind, p_id: id });
    setBusy(false);
    if (e) {
      setError(friendlyCatalogError(e.message));
      return;
    }
    setNotice(result === 'archived' ? `«${name}» скрыта: по ней есть записи, они остались как были` : `«${name}» удалена`);
    // вышли из удалённого элемента
    if ((kind === 'profession' && view.level === 'models' && view.professionId === id) || (kind === 'model' && view.level === 'operations' && view.modelId === id)) {
      setView(kind === 'model' && model ? { level: 'models', professionId: model.profession_id } : { level: 'professions' });
    }
    await reload();
  }

  // Перенос — одним нажатием на целевую модель (профессию): операция остаётся той же,
  // записи и суммы не меняются.
  async function moveOperationTo(opId: string, modelId: string) {
    const target = data.models.find((m) => m.id === modelId);
    const prof = data.professions.find((p) => p.id === target?.profession_id);
    if (await run(() => supabase.from('catalog_operations').update({ model_id: modelId }).eq('id', opId), `Операция перенесена в «${prof?.name ?? ''} / ${target?.name ?? ''}»`)) setMoving(null);
  }

  async function moveModelTo(modelId: string, professionId: string) {
    const prof = data.professions.find((p) => p.id === professionId);
    if (await run(() => supabase.from('catalog_models').update({ profession_id: professionId }).eq('id', modelId), `Модель перенесена в «${prof?.name ?? ''}»`)) setMoving(null);
  }

  const addPlaceholder = view.level === 'professions' ? 'Новая профессия' : view.level === 'models' ? 'Новая модель' : 'Новая операция';
  const addRateLabel = view.level === 'models' ? 'цена целиком, сум' : 'сум за штуку';

  return (
    <div className="space-y-5">
      {error && <p className="text-sm text-danger-600">{error}</p>}
      {notice && <p className="text-sm font-medium text-success-600">{notice}</p>}
      {!loaded && <p className="text-sm text-slate-400">Загрузка…</p>}

      {view.level !== 'professions' && (
        <nav className="flex flex-wrap items-center gap-x-1 text-sm">
          <button type="button" onClick={() => go({ level: 'professions' })} className="btn-link">
            Профессии
          </button>
          {view.level === 'models' && <span className="text-slate-500">/ {profession?.name}</span>}
          {view.level === 'operations' && (
            <>
              <span className="text-slate-400">/</span>
              <button
                type="button"
                onClick={() => model && go({ level: 'models', professionId: model.profession_id })}
                className="btn-link"
              >
                {modelProfession?.name}
              </button>
              <span className="text-slate-500">/ {model?.name}</span>
            </>
          )}
        </nav>
      )}

      {loaded && view.level === 'professions' && (
        <div className="space-y-2">
          {data.professions.length === 0 && <p className="text-sm text-slate-400">Профессий пока нет — добавьте первую ниже</p>}
          {data.professions.map((p) => {
            const models = modelsOf.get(p.id) ?? [];
            return (
              <div key={p.id} className="card space-y-2">
                <NameRow editing={editing} setEditing={setEditing} busy={busy} onSave={saveRename} kind="profession" id={p.id} name={p.name}>
                  <button type="button" onClick={() => go({ level: 'models', professionId: p.id })} className="block w-full text-left">
                    <span className="block font-medium text-slate-900">{p.name}</span>
                    <span className="text-xs text-slate-500">
                      Моделей: {models.length}
                    </span>
                  </button>
                </NameRow>
                <div className="flex gap-2">
                  <button type="button" onClick={() => go({ level: 'models', professionId: p.id })} className="btn-tonal">
                    Открыть
                  </button>
                  <button type="button" disabled={busy} onClick={() => removeItem('profession', p.id, p.name)} className="btn-tonal-danger">
                    Удалить
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {loaded && view.level === 'models' && profession && (
        <div className="space-y-2">
          <NameRow editing={editing} setEditing={setEditing} busy={busy} onSave={saveRename} kind="profession" id={profession.id} name={profession.name}>
            <h2 className="text-lg font-semibold text-slate-900">{profession.name}</h2>
          </NameRow>
          {(modelsOf.get(profession.id) ?? []).length === 0 && <p className="text-sm text-slate-400">Моделей пока нет — добавьте первую ниже</p>}
          {(modelsOf.get(profession.id) ?? []).map((m) => (
            <div key={m.id} className="card space-y-2">
              <NameRow editing={editing} setEditing={setEditing} busy={busy} onSave={saveRename} kind="model" id={m.id} name={m.name}>
                <button type="button" onClick={() => go({ level: 'operations', modelId: m.id })} className="block w-full text-left">
                  <span className="block font-medium text-slate-900">{m.name}</span>
                  <span className="text-xs text-slate-500">
                    Операций: {(opsOf.get(m.id) ?? []).length}
                    {m.whole_rate ? ` · целиком ${formatMoney(m.whole_rate)}` : ''}
                  </span>
                </button>
              </NameRow>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => go({ level: 'operations', modelId: m.id })} className="btn-tonal">
                  Операции
                </button>
                <button
                  type="button"
                  onClick={() => setMoving({ kind: 'model', id: m.id, professionId: '', modelId: '' })}
                  className="btn-tonal"
                >
                  Перенести
                </button>
                <button type="button" disabled={busy} onClick={() => removeItem('model', m.id, m.name)} className="btn-tonal-danger">
                  Удалить
                </button>
              </div>
              {moving && moving.kind === 'model' && moving.id === m.id && (
                <div className="space-y-2 rounded-md bg-slate-50 p-3">
                  <p className="text-xs font-medium text-slate-500">Куда перенести модель — нажмите профессию:</p>
                  <div className="flex flex-wrap gap-2">
                    {data.professions
                      .filter((p) => p.id !== m.profession_id)
                      .map((p) => (
                        <button key={p.id} type="button" disabled={busy} onClick={() => moveModelTo(m.id, p.id)} className="btn-tonal">
                          {p.name}
                        </button>
                      ))}
                    <button type="button" onClick={() => setMoving(null)} className="btn-ghost-muted">
                      Отмена
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {loaded && view.level === 'operations' && model && (
        <div className="space-y-3">
          <div className="card space-y-3">
            <NameRow editing={editing} setEditing={setEditing} busy={busy} onSave={saveRename} kind="model" id={model.id} name={model.name}>
              <h2 className="text-lg font-semibold text-slate-900">{model.name}</h2>
            </NameRow>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500">
                Цена за изделие целиком, сум — если у модели есть такая цена (пусто = нет)
              </span>
              <MoneyInput
                className="input w-44"
                placeholder="нет"
                value={drafts[`whole:${model.id}`] ?? ''}
                onChange={(digits) => setDrafts((prev) => ({ ...prev, [`whole:${model.id}`]: digits }))}
                onBlur={() => saveWholeRate(model)}
              />
            </label>
          </div>

          <h3 className="text-sm font-semibold text-slate-700">Операции и расценки</h3>
          {(opsOf.get(model.id) ?? []).length === 0 && <p className="text-sm text-slate-400">Операций пока нет — добавьте первую ниже</p>}
          {(opsOf.get(model.id) ?? []).map((op) => {
            const noRate = !(op.rate_per_piece > 0);
            return (
              <div key={op.id} className={`card space-y-2 ${noRate ? 'border-warning-300 bg-warning-50' : ''}`}>
                <NameRow editing={editing} setEditing={setEditing} busy={busy} onSave={saveRename} kind="operation" id={op.id} name={op.name}>
                  <span className="block font-medium text-slate-900">{op.name}</span>
                  {noRate && <span className="text-xs font-medium text-warning-700">ставка не задана</span>}
                </NameRow>
                <div className="flex flex-wrap items-center gap-2">
                  <MoneyInput
                    className="input w-36"
                    placeholder="0"
                    value={drafts[`op:${op.id}`] ?? ''}
                    onChange={(digits) => setDrafts((prev) => ({ ...prev, [`op:${op.id}`]: digits }))}
                    onBlur={() => saveOperationRate(op)}
                  />
                  <span className="text-xs text-slate-500">сум/шт</span>
                  <button
                    type="button"
                    onClick={() => setMoving({ kind: 'operation', id: op.id, professionId: model.profession_id, modelId: '' })}
                    className="btn-tonal ml-auto"
                  >
                    Перенести
                  </button>
                  <button type="button" disabled={busy} onClick={() => removeItem('operation', op.id, op.name)} className="btn-tonal-danger">
                    Удалить
                  </button>
                </div>
                {moving && moving.kind === 'operation' && moving.id === op.id && (
                  <div className="space-y-3 rounded-md bg-slate-50 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-medium text-slate-500">Куда перенести «{op.name}» — нажмите модель:</p>
                      <button type="button" onClick={() => setMoving(null)} className="btn-ghost-muted shrink-0">
                        Отмена
                      </button>
                    </div>
                    {[...data.professions]
                      .sort((a, b) => (a.id === model.profession_id ? -1 : b.id === model.profession_id ? 1 : a.name.localeCompare(b.name, 'ru')))
                      .map((p) => {
                        const targets = data.models.filter((x) => x.profession_id === p.id && x.id !== op.model_id);
                        if (targets.length === 0) return null;
                        return (
                          <div key={p.id}>
                            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{p.name}</p>
                            <div className="flex flex-wrap gap-2">
                              {targets.map((x) => (
                                <button key={x.id} type="button" disabled={busy} onClick={() => moveOperationTo(op.id, x.id)} className="btn-tonal">
                                  {x.name}
                                </button>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {loaded && (
        <div className="card space-y-2 border-dashed">
          <h3 className="text-sm font-semibold text-slate-700">
            {view.level === 'professions' ? 'Добавить профессию' : view.level === 'models' ? 'Добавить модель' : 'Добавить операцию'}
          </h3>
          <input
            className="input"
            placeholder={addPlaceholder}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addItem()}
          />
          {view.level !== 'professions' && (
            <MoneyInput className="input w-48" placeholder={addRateLabel} value={newRate} onChange={setNewRate} />
          )}
          <button type="button" disabled={busy || !newName.trim()} onClick={addItem} className="btn-primary w-full sm:w-auto">
            Добавить
          </button>
        </div>
      )}
    </div>
  );
}
