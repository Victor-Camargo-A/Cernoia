export function formatCurrency(value: string | number | null | undefined) {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) return "$0";
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
    notation: numeric >= 1_000_000_000 ? "compact" : "standard",
  }).format(numeric);
}

export function formatDate(value: string | null | undefined, withTime = false) {
  if (!value) return "Sin fecha";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Sin fecha";
  return new Intl.DateTimeFormat("es-CO", {
    timeZone: /^\d{4}-\d{2}-\d{2}$/.test(value) ? "UTC" : "America/Bogota",
    day: "2-digit",
    month: "short",
    year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(date);
}

export function daysUntil(value: string | null | undefined) {
  if (!value) return null;
  const target = new Date(value).getTime();
  if (!Number.isFinite(target)) return null;
  return Math.ceil((target - Date.now()) / 86_400_000);
}

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}
