import AppNav from "@/components/AppNav";
import PreviousList from "@/components/PreviousList";
import { getMapData } from "@/lib/map-data";

export const dynamic = "force-dynamic";

export default async function Page() {
  const d = await getMapData();
  return (<><AppNav role={d.role} info={`${d.previous.length} viajes anteriores`} /><PreviousList data={d.previous} role={d.role} /></>);
}
