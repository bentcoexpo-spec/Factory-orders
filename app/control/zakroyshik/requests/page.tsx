'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { CUTTING_REQUEST_STATUS_LABELS, CuttingRequest, CuttingRequestStatus, RawMaterialColor, sizeRank } from '@/lib/types';
import { formatDate } from '@/lib/format';
import RequireRole from '@/components/RequireRole';

function IconChevronLeft() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-4 w-4">
      <path d="M12.5 4.5 7 10l5.5 5.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const STATUS_BADGE: Record<CuttingRequestStatus, string> = {
  new: 'bg-slate-100 text-slate-600',
  in_progress: 'bg-accent-100 text-accent-700',
  done: 'bg-success-100 text-success-700',
  cancelled: 'bg-danger-100 text-danger-600',
};

interface SizeRow {
  size: string;
  quantity: string;
}

interface DraftProduct {
  name: string;
  rows: { size: string | null; quantity: number }[];
}

function emptyRows(): SizeRow[] {
  return [{ size: '', quantity: '' }];
}

function RequestsContent() {
  const [colors, setColors] = useState<RawMaterialColor[]>([]);
  const [requests, setRequests] = useState<CuttingRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedMaterial, setSelectedMaterial] = useState<string | null>(null);
  const [selectedColor, setSelectedColor] = useState<RawMaterialColor | null>(null);
  const [rollsHint, setRollsHint] = useState('');
  const [comment, setComment] = useState('');
  const [products, setProducts] = useState<DraftProduct[]>([]);

  const [productName, setProductName] = useState('');
  const [bySize, setBySize] = useState(false);
  const [singleQty, setSingleQty] = useState('');
  const [rows, setRows] = useState<SizeRow[]>(emptyRows());

  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function loadColors() {
    const { data, error } = await supabase
      .from('raw_material_colors_view')
      .select('*')
      .order('material_name')
      .order('color');
    if (error) setLoadError(error.message);
    else setColors((data as unknown as RawMaterialColor[]) ?? []);
  }

  async function loadRequests() {
    setLoading(true);
    const { data, error } = await supabase
      .from('cutting_requests_view')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) setLoadError(error.message);
    else setRequests((data as unknown as CuttingRequest[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    loadColors();
    loadRequests();
  }, []);

  function resetForm() {
    setEditingId(null);
    setSelectedMaterial(null);
    setSelectedColor(null);
    setRollsHint('');
    setComment('');
    setProducts([]);
    setProductName('');
    setBySize(false);
    setSingleQty('');
    setRows(emptyRows());
    setFormError(null);
  }

  function startEdit(req: CuttingRequest) {
    setSuccess(null);
    setActionError(null);
    const match = colors.find((c) => c.id === req.color_id);
    setSelectedColor(
      match ?? { id: req.color_id, material_id: '', material_name: req.material_name, color: req.color, stock_rolls: 0, created_at: '' }
    );
    setSelectedMaterial(null);
    setRollsHint(req.rolls_hint != null ? String(req.rolls_hint) : '');
    setComment(req.comment ?? '');
    setProducts(
      req.products.map((p) => ({
        name: p.product_name,
        rows: p.sizes.map((s) => ({ size: s.size, quantity: s.quantity })),
      }))
    );
    setProductName('');
    setBySize(false);
    setSingleQty('');
    setRows(emptyRows());
    setEditingId(req.id);
    setFormError(null);
  }

  function updateRow(index: number, patch: Partial<SizeRow>) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  function addRow() {
    setRows((prev) => [...prev, { size: '', quantity: '' }]);
  }

  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  function addProductToDraft() {
    setFormError(null);
    const name = productName.trim();
    if (!name) {
      setFormError('Укажите название товара');
      return;
    }
    if (products.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      setFormError('Такой товар уже добавлен в заявку');
      return;
    }

    if (bySize) {
      const filled = rows
        .map((r) => ({ size: r.size.trim(), quantity: Number(r.quantity) }))
        .filter((r) => r.size && r.quantity > 0);
      if (filled.length === 0) {
        setFormError('Укажите хотя бы один размер и количество');
        return;
      }
      const sizesLower = filled.map((r) => r.size.toLowerCase());
      if (new Set(sizesLower).size !== sizesLower.length) {
        setFormError('Один размер указан дважды');
        return;
      }
      setProducts((prev) => [...prev, { name, rows: filled.map((r) => ({ size: r.size, quantity: r.quantity })) }]);
    } else {
      const qty = Number(singleQty);
      if (!qty || qty <= 0) {
        setFormError('Укажите количество');
        return;
      }
      setProducts((prev) => [...prev, { name, rows: [{ size: null, quantity: qty }] }]);
    }

    setProductName('');
    setBySize(false);
    setSingleQty('');
    setRows(emptyRows());
  }

  function removeProduct(index: number) {
    setProducts((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit() {
    setFormError(null);
    setSuccess(null);
    if (!selectedColor) {
      setFormError('Выберите материал и цвет');
      return;
    }
    if (products.length === 0) {
      setFormError('Добавьте хотя бы один товар');
      return;
    }

    const rollsNum = rollsHint.trim() === '' ? null : Number(rollsHint);
    if (rollsNum !== null && (Number.isNaN(rollsNum) || rollsNum <= 0)) {
      setFormError('Количество рулонов должно быть положительным числом');
      return;
    }

    const payload = products.map((p) => ({
      product_name: p.name,
      rows: p.rows.map((r) => ({ size: r.size ?? '', quantity: r.quantity })),
    }));

    setSaving(true);
    const { error } = editingId
      ? await supabase.rpc('update_cutting_request', {
          p_request_id: editingId,
          p_color_id: selectedColor.id,
          p_rolls_hint: rollsNum,
          p_comment: comment,
          p_products: payload,
        })
      : await supabase.rpc('create_cutting_request', {
          p_color_id: selectedColor.id,
          p_rolls_hint: rollsNum,
          p_comment: comment,
          p_products: payload,
        });
    setSaving(false);

    if (error) {
      setFormError(error.message);
      return;
    }

    setSuccess(editingId ? 'Заявка обновлена' : 'Заявка создана');
    resetForm();
    loadRequests();
  }

  async function handleCancelRequest(req: CuttingRequest) {
    if (!confirm(`Отменить заявку «${req.material_name} · ${req.color}»?`)) return;
    setActionError(null);
    const { error } = await supabase.rpc('cancel_cutting_request', { p_request_id: req.id });
    if (error) setActionError(error.message);
    else {
      if (editingId === req.id) resetForm();
      loadRequests();
    }
  }

  async function handleCompleteRequest(req: CuttingRequest) {
    if (!confirm(`Отметить заявку «${req.material_name} · ${req.color}» выполненной?`)) return;
    setActionError(null);
    const { error } = await supabase.rpc('complete_cutting_request', { p_request_id: req.id });
    if (error) setActionError(error.message);
    else {
      if (editingId === req.id) resetForm();
      loadRequests();
    }
  }

  const groupedMaterials = Array.from(
    colors.reduce((map, c) => {
      const list = map.get(c.material_name) ?? [];
      list.push(c);
      map.set(c.material_name, list);
      return map;
    }, new Map<string, RawMaterialColor[]>())
  ).sort(([a], [b]) => a.localeCompare(b));

  const materialColors = selectedMaterial ? colors.filter((c) => c.material_name === selectedMaterial) : [];

  const active = requests.filter((r) => r.status === 'new' || r.status === 'in_progress');
  const finished = requests.filter((r) => r.status === 'done' || r.status === 'cancelled');

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Заявка</h1>
        <p className="mt-1 text-sm text-slate-500">
          Что раскроить — закройщик увидит заявку у себя и укажет её при отчёте о партии
        </p>
      </div>

      {loadError && <p className="text-sm text-danger-600">{loadError}</p>}

      <div className="space-y-4 card">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700">
            {editingId ? 'Редактирование заявки' : 'Новая заявка'}
          </h2>
          {editingId && (
            <button type="button" onClick={resetForm} className="text-xs font-medium text-accent-600 hover:underline">
              Отменить редактирование
            </button>
          )}
        </div>

        {success && <p className="text-sm font-medium text-success-600">{success}</p>}

        {!selectedColor && !selectedMaterial && (
          <div className="space-y-2">
            {groupedMaterials.length === 0 && <p className="text-sm text-slate-400">На складе сырья пока пусто</p>}
            {groupedMaterials.map(([name, list]) => {
              const total = list.reduce((sum, c) => sum + c.stock_rolls, 0);
              return (
                <button
                  key={name}
                  type="button"
                  onClick={() => setSelectedMaterial(name)}
                  className="flex w-full items-center justify-between card text-left"
                >
                  <div>
                    <p className="font-medium text-slate-800">{name}</p>
                    <p className="text-xs text-slate-400">
                      {list.length} {list.length === 1 ? 'цвет' : 'цветов'}
                    </p>
                  </div>
                  <span className="text-sm font-medium text-slate-600">{total} рул.</span>
                </button>
              );
            })}
          </div>
        )}

        {!selectedColor && selectedMaterial && (
          <div className="space-y-4">
            <button
              type="button"
              onClick={() => setSelectedMaterial(null)}
              className="btn-link"
            >
              <IconChevronLeft />
              Все материалы
            </button>
            <h3 className="text-base font-semibold text-slate-900">{selectedMaterial}</h3>
            <div className="flex flex-wrap gap-2">
              {materialColors.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSelectedColor(c)}
                  className="rounded-md border border-slate-200 bg-white px-3 py-2.5 text-left text-sm"
                >
                  <span className="block font-medium text-slate-800">{c.color}</span>
                  <span className="text-xs text-slate-400">Остаток {c.stock_rolls}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {selectedColor && (
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div>
                <p className="text-base font-medium text-slate-800">{selectedColor.material_name}</p>
                <p className="text-sm text-slate-500">{selectedColor.color}</p>
                <p className="text-xs text-slate-400">На складе: {selectedColor.stock_rolls} рул.</p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedColor(null)}
                className="btn-ghost"
              >
                Изменить
              </button>
            </div>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500">Сколько рулонов — по желанию</span>
              <input
                type="number"
                min={1}
                step="1"
                inputMode="numeric"
                placeholder="например 5"
                className="input sm:max-w-[160px]"
                value={rollsHint}
                onChange={(e) => setRollsHint(e.target.value)}
              />
            </label>

            {products.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-slate-700">Что кроить</h3>
                {products.map((p, i) => (
                  <div key={i} className="flex items-start justify-between rounded-lg border border-slate-200 bg-white p-3">
                    <div>
                      <p className="font-medium text-slate-800">{p.name}</p>
                      <p className="text-xs text-slate-400">
                        {p.rows[0].size === null
                          ? `${p.rows[0].quantity} шт.`
                          : p.rows.map((r) => `${r.size} ${r.quantity}`).join(', ')}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeProduct(i)}
                      className="btn-ghost-danger shrink-0"
                    >
                      Убрать
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-3 rounded-lg border border-dashed border-slate-300 p-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">Название товара</span>
                <input
                  className="input"
                  placeholder="например Футболка"
                  value={productName}
                  onChange={(e) => setProductName(e.target.value)}
                />
              </label>

              <label className="flex items-center gap-2 text-sm text-slate-600">
                <input type="checkbox" checked={bySize} onChange={(e) => setBySize(e.target.checked)} />
                Указать по размерам
              </label>

              {!bySize && (
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-slate-500">Количество</span>
                  <input
                    type="number"
                    min={1}
                    step="1"
                    inputMode="numeric"
                    className="input sm:max-w-[160px]"
                    value={singleQty}
                    onChange={(e) => setSingleQty(e.target.value)}
                  />
                </label>
              )}

              {bySize && (
                <div className="space-y-2">
                  {rows.map((row, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input
                        className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2.5 text-base"
                        placeholder="Размер, например M"
                        value={row.size}
                        onChange={(e) => updateRow(i, { size: e.target.value })}
                      />
                      <input
                        type="number"
                        min={1}
                        step="1"
                        inputMode="numeric"
                        className="w-24 shrink-0 rounded-md border border-slate-300 px-3 py-2.5 text-base"
                        placeholder="Кол-во"
                        value={row.quantity}
                        onChange={(e) => updateRow(i, { quantity: e.target.value })}
                      />
                      <button
                        type="button"
                        onClick={() => removeRow(i)}
                        disabled={rows.length === 1}
                        className="btn-ghost-danger shrink-0"
                        aria-label="Убрать строку"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={addRow}
                    className="btn-dashed"
                  >
                    + Добавить размер
                  </button>
                </div>
              )}

              <button
                type="button"
                onClick={addProductToDraft}
                className="btn-dashed-accent"
              >
                + Добавить товар в заявку
              </button>
            </div>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500">Комментарий — по желанию</span>
              <textarea
                className="input"
                rows={2}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
            </label>

            {formError && <p className="text-sm text-danger-600">{formError}</p>}

            <button
              type="button"
              onClick={handleSubmit}
              disabled={saving || products.length === 0}
              className="btn-primary w-full sm:w-auto"
            >
              {saving ? 'Сохранение…' : editingId ? 'Сохранить изменения' : 'Создать заявку'}
            </button>
          </div>
        )}
      </div>

      {actionError && <p className="text-sm text-danger-600">{actionError}</p>}

      {loading && <p className="text-sm text-slate-400">Загрузка…</p>}

      {!loading && (
        <div className="space-y-6">
          <div className="space-y-2">
            <h2 className="text-sm font-semibold text-slate-700">Активные заявки</h2>
            {active.length === 0 && <p className="text-sm text-slate-400">Активных заявок нет</p>}
            {active.map((r) => (
              <RequestCard
                key={r.id}
                req={r}
                onEdit={() => startEdit(r)}
                onCancel={() => handleCancelRequest(r)}
                onComplete={() => handleCompleteRequest(r)}
              />
            ))}
          </div>

          {finished.length > 0 && (
            <div className="space-y-2">
              <h2 className="text-sm font-semibold text-slate-700">Завершённые / отменённые</h2>
              {finished.map((r) => (
                <RequestCard key={r.id} req={r} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RequestCard({
  req,
  onEdit,
  onCancel,
  onComplete,
}: {
  req: CuttingRequest;
  onEdit?: () => void;
  onCancel?: () => void;
  onComplete?: () => void;
}) {
  const editable = req.status === 'new' || req.status === 'in_progress';
  return (
    <div className="card">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-medium text-slate-800">
            {req.material_name}
            <span className="text-slate-400"> · {req.color}</span>
          </p>
          <p className="text-xs text-slate-400">
            {formatDate(req.created_at)}
            {req.created_by_email && ` · ${req.created_by_email}`}
            {req.rolls_hint != null && ` · ~${req.rolls_hint} рул.`}
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_BADGE[req.status]}`}>
          {CUTTING_REQUEST_STATUS_LABELS[req.status]}
        </span>
      </div>

      {req.comment && <p className="mt-2 text-sm text-slate-500">{req.comment}</p>}

      <div className="mt-2 space-y-1 border-t border-slate-100 pt-2">
        {req.products.map((p, i) => (
          <div key={i} className="text-xs text-slate-600">
            <span className="font-medium text-slate-700">{p.product_name}</span>
            {' — план '}
            {p.sizes[0]?.size === null
              ? p.plan_total
              : [...p.sizes]
                  .sort((a, b) => sizeRank(a.size) - sizeRank(b.size))
                  .map((s) => `${s.size} ${s.quantity}`)
                  .join(', ')}
            {', факт '}
            <span className={p.fact_total >= p.plan_total ? 'font-medium text-success-700' : 'font-medium text-warning-700'}>
              {p.fact_total}
            </span>
          </div>
        ))}
      </div>

      {editable && (onEdit || onCancel || onComplete) && (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-100 pt-3">
          {onEdit && (
            <button type="button" onClick={onEdit} className="btn-tonal">
              Изменить
            </button>
          )}
          {onComplete && (
            <button type="button" onClick={onComplete} className="btn-tonal-success">
              Отметить выполненной
            </button>
          )}
          {onCancel && (
            <button type="button" onClick={onCancel} className="btn-tonal-danger">
              Отменить
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function CuttingRequestsPage() {
  return (
    <RequireRole roles={['ceo']}>
      <RequestsContent />
    </RequireRole>
  );
}
