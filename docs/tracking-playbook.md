# Guía de seguimiento de buques (playbook)

Conocimiento acumulado para que el agente de seguimiento no se bloquee. Aquí no hay datos operativos
(ni chasis, ni números de BL, ni precios): solo cómo funciona cada naviera.

## Regla de oro
Ningún buque debe pasar de 48 h sin actualizarse. La plataforma lo vigila sola: alerta "Buque sin actualizar"
(media a las 36 h, importante a las 48 h). Cada buque tiene su propio reloj: una naviera que falla no frena a las demás.

## Cómo corre el agente
- Tarea programada cada 3 h; en cada vuelta pide `/api/tracking/pending` y recibe **solo los buques con 24 h o más sin lectura buena**.
- Los que fallan se reintentan en la vuelta siguiente (3 h después); los que salieron bien esperan 24 h.
- Al reportar, el agente lista en `run.read_ok` los buques leídos aunque no hayan cambiado (así su reloj se reinicia),
  y en `run.errors` el motivo corto de cada fallo (queda guardado para diagnóstico).

## Incidente 10-nov-2026: ONE bloqueada (causa y solución)
- **Qué pasó:** el agente no pudo escribir el número en el buscador de ONE porque un aviso emergente tapaba el campo.
  Además tenía prohibido hacer clic en cualquier cosa que no fuera "buscar", y la corrida se dio por buena porque MSC sí leyó
  (ONE quedó 24 h más sin reintento).
- **Causa 1:** ONE muestra avisos emergentes (cookies y un recorrido guiado "Customize Columns" con botones Skip / Try it).
- **Causa 2:** el número iba con el prefijo `ONEY`. ONE pide los **últimos 12 caracteres, sin `ONEY`**; con el prefijo responde "No Data Found".
- **Causa 3:** el reloj de 24 h era global, no por buque.
- **Solución verificada (10-nov-2026):** abrir directamente
  `https://ecomm.one-line.com/one-ecom/manage-shipment/cargo-tracking?trakNoParam=<NUMERO_SIN_ONEY>`
  La página llena la búsqueda sola y muestra el resultado, sin escribir nada. Los avisos emergentes no impiden leer el texto con `get_page_text`.
  La plataforma ya entrega esa URL lista en `item.url` y el número sin `ONEY` en `item.numbers`.

## Recetas por naviera

### ONE (Ocean Network Express)
- Usar `item.url` tal cual (ya trae el número). No escribir en el buscador.
- Esperar ~5 s y leer con `get_page_text`. Si dice "No Data Found": revisar que el número no lleve `ONEY` y reintentar una vez; si persiste, es fallo.
- Número de contenedor (`TYOG…`) o BL/booking: ambos sirven; no acepta BL de agente (house BL).
- Qué leer: fila de resultado → "Latest Event Status/Time" (último evento real) y "POD/Vessel Arrival" (= ETA a destino).
  Debajo, "Sailing Information" lista cada tramo con su buque; los eventos futuros son estimados, no reales.
- Transbordo: ONE usa buques de distinto nombre por tramo (p. ej. alimentador en Panamá). `vessel` = buque del tramo actual
  (el que ya zarpó con la carga). Si la carga espera en el puerto de transbordo, mantener el nombre actual.
- Mapeo de eventos: Gate In / Loaded on Vessel at Port of Loading = `loading_origin`; Vessel Departure from Port of Loading = `departed`;
  Vessel Arrival / Unloaded / Loaded / Departure at T/S Port = `in_transit` (si el transbordo es en Panamá, `panama`);
  Vessel Arrival at Port of Discharge = `arrived`; Unloaded from Vessel at Port of Discharging = `discharged`.
- Avisos que pueden salir: cookies, recorrido "Customize Columns" (botón **Skip**). Se pueden cerrar con Skip/rechazar; no hace falta para leer.

### MSC
- El enlace NO acepta el número (probado). Hay que escribirlo en "Container/Bill of Lading Number" y pulsar Enter.
- Rechazar cookies (Reject All) si salen. Recargar la página entre una búsqueda y otra.
- Leer movimientos (el más reciente arriba), buque actual y "POD ETA".

### Crowley (RORO)
- Se busca por chasis: FCL Cargo → "Cargo VIN/Serial #" → Submit. Si la reserva no devuelve nada, usar siempre el chasis.

### Otras navieras
- Usar `item.url` con el número. Ver `src/lib/carriers.ts`. Maersk también acepta el número en la dirección.

## Si algo falla (en este orden)
1. Cerrar avisos emergentes con la opción menos intrusiva (Skip, Reject all, cerrar). Está permitido; no es "navegar".
2. Para ONE usar siempre el enlace con `trakNoParam` y sin `ONEY`.
3. Reintentar una vez la misma búsqueda tras recargar (máx. ~2 min por naviera).
4. Si hay captcha, inicio de sesión obligatorio o bloqueo: contar como fallo, anotar el motivo en `run.errors` y seguir con el siguiente buque.
   Nunca iniciar sesión, crear cuentas ni resolver captchas.
5. El fallo se reintenta solo en 3 h. A las 36 h sin lectura aparece la alerta en la plataforma; a las 48 h es "importante".

## Fuentes de respaldo (sin probar; usar solo si la naviera falla dos vueltas seguidas y verificar que coincida buque y contenedor)
- Agregadores públicos de seguimiento por contenedor/booking (ShipsGo, Ship24, TimeToCargo). Son terceros: validar contra la naviera cuando se pueda.
- ONE ofrece también seguimiento por correo (cargotracking@one-line.com): requiere enviar un mensaje, no es automático.

## Pendiente por evaluar
- Si ONE vuelve a cambiar la página, actualizar esta guía y `src/lib/carriers.ts`.
