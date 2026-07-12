const exactNumber = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });
const compactNumber = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 0, maximumFractionDigits: 1 });

export function formatExactNumber(value: number | null | undefined) {
  return exactNumber.format(normalizeMetric(value));
}

export function formatDashboardMetric(value: number | null | undefined) {
  const normalized = normalizeMetric(value);
  if (Math.abs(normalized) < 1_000) return exactNumber.format(normalized);
  return `${compactNumber.format(normalized / 1_000)}K`;
}

function normalizeMetric(value: number | null | undefined) {
  const normalized = Number(value ?? 0);
  return Number.isFinite(normalized) ? Math.round(normalized) : 0;
}
