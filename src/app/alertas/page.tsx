import AppNav from "@/components/AppNav";
import AlertsList from "@/components/AlertsList";
import { getAlerts } from "@/lib/alerts";

export const dynamic = "force-dynamic";

export default async function Page() {
  const d = await getAlerts();
  const n = d.items.filter((i) => i.priority === "alta").length;
  return (<><AppNav role={d.role} info={`${d.items.length} alertas${n ? ` · ${n} urgentes` : ""}`} /><AlertsList items={d.items} /></>);
}
