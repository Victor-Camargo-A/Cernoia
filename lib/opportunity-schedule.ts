import type { Opportunity } from "./api";
export function opportunityDays(item: Opportunity, now = new Date()) {
  const deadline=item.schedule?.deadline;
  if (!deadline) return null;
  if(deadline.precision === "datetime") return Math.ceil((new Date(deadline.value).getTime()-now.getTime())/86_400_000);
  const today=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Bogota",year:"numeric",month:"2-digit",day:"2-digit"}).format(now);
  return Math.round((Date.parse(deadline.value+"T00:00:00Z")-Date.parse(today+"T00:00:00Z"))/86_400_000);
}
