import AppNav from "@/components/AppNav";
import VehicleList from "@/components/VehicleList";
import { getVehicles } from "@/lib/vehicles-data";

export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const { cards, role } = await getVehicles();
  return (<><AppNav role={role} info={`${cards.length} vehículos`} /><VehicleList cards={cards} role={role} initialQuery={q} /></>);
}
