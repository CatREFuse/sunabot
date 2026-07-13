const exactNumber = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });
const compactNumber = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 0, maximumFractionDigits: 1 });
const percentNumber = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 0, maximumFractionDigits: 1 });

export function formatExactNumber(value: number | null | undefined) {
  return exactNumber.format(normalizeMetric(value));
}

export function formatDashboardMetric(value: number | null | undefined) {
  const normalized = normalizeMetric(value);
  if (Math.abs(normalized) < 1_000) return exactNumber.format(normalized);
  if (Math.abs(normalized) >= 1_000_000) return `${compactNumber.format(normalized / 1_000_000)}M`;
  return `${compactNumber.format(normalized / 1_000)}K`;
}

export function formatPercent(value: number | null | undefined) {
  const normalized = Number(value);
  if (value == null || !Number.isFinite(normalized)) return "--";
  return `${percentNumber.format(Math.min(Math.max(normalized, 0), 1) * 100)}%`;
}

function normalizeMetric(value: number | null | undefined) {
  const normalized = Number(value ?? 0);
  return Number.isFinite(normalized) ? Math.round(normalized) : 0;
}
