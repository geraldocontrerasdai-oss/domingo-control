import MapView from "@/components/MapView";
import { getMapData } from "@/lib/map-data";

export const dynamic = "force-dynamic";

export default async function Mapa() {
  return <MapView data={await getMapData()} />;
}
