# Límite del contenido

> **Audiencia:** todas las personas que necesitan el modelo mental del **límite entre el contenido del host y la gobernanza del CMS**. Esta página explica cómo una única ruta canónica del host se convierte en una proyección servida sin escribirse a través de un alias, cómo el comercio permanece *coordinator-gated* y cómo la reversión y la propagación en vivo permanecen en momentos separados. La invariante a nivel de producto se repite en [`docs/overview.md`](../overview.es.md) y [`docs/concepts/architecture.es.md`](architecture.es.md); esta página de concepto reúne el límite en una referencia autocontenida.

El límite del contenido **no** es una lista de permisos. Es una topología de lectura/escritura. El repositorio del host es el único lugar donde viven los bytes de contenido autorizados; el CMS posee la propuesta, aprobación, auditoría, vista previa, reconciliación y reversión con una sola acción que envuelven esa escritura.

## La forma del límite

Una vinculación de región declara tres campos congelados:

- `canonical_source` — la única ruta del host autorizada a la que apunta la vinculación. El host conserva los bytes.
- `derived_artifacts[]` — la lista cerrada de rutas servidas o derivadas que mantiene el adaptador. Nunca se debe pedir al adaptador que escriba en ellas directamente.
- `regeneration_contract` — cómo se materializan las escrituras canónicas en forma servida. v1 reconoce exactamente un modo: `alias_symlink`.

El CMS escribe en `canonical_source`. El host sirve los `derived_artifacts`. Nada más cruza el límite por el lado de la escritura.

## Fuente canónica frente a artefactos derivados

La fuente canónica es un archivo real y nativo del host. En el despliegue de referencia de Cerafica, la ruta canónica de productos es `inventory/products.json`. Los adaptadores la resuelven a través del *backend* del host; el sistema lee a través de ese puntero ([`packages/adapter-sdk/src/index.ts`](../../packages/adapter-sdk/src/index.ts#L11-L23), [`packages/storage/src/schema.ts`](../../packages/storage/src/schema.ts#L186-L233)).

Los artefactos derivados son una lista cerrada de rutas servidas o derivadas. Para Cerafica, la ruta servida es `website/data/products.json`. El contrato es explícito: **nunca se debe pedir a los adaptadores que escriban directamente en los artefactos derivados** ([`packages/adapter-sdk/src/index.ts`](../../packages/adapter-sdk/src/index.ts#L11-L23)). Las escrituras directas a rutas derivadas se rechazan en el límite del adaptador con `E_DERIVED_WRITE_FORBIDDEN`.

## El contrato de regeneración `alias_symlink`

En el modo `alias_symlink`, la ruta servida es un alias del sistema de archivos cuyo objetivo se resuelve a la fuente canónica. Cerafica declara:

- canónica: `inventory/products.json`
- alias servido: `website/data/products.json`
- objetivo del alias declarado: `../../inventory/products.json` (resuelto respecto a la raíz del repositorio)

El adaptador no "copia" bytes en la ruta servida. Verifica que el alias exista, sea un *symlink* (no un archivo regular), se resuelva dentro del repositorio, no tenga ciclos y apunte a la fuente canónica. Un alias faltante, roto, reorientado, que se escapa, en bucle o reemplazado por un archivo regular se rechaza en la activación; la reconciliación vuelve a ejecutar la misma verificación y rechaza informar de éxito hasta que el alias esté sano ([`packages/adapter-cerafica/src/index.ts`](../../packages/adapter-cerafica/src/index.ts#L1-L24), [`packages/adapter-cerafica/src/symlink.ts`](../../packages/adapter-cerafica/src/symlink.ts)).

Concretamente: al aplicar, solo se escribe `inventory/products.json`. Al servir, el sitio web lee `website/data/products.json`, que el sistema operativo resuelve a `inventory/products.json`. No existe una segunda fuente de verdad ni oportunidad de que ambas se desincronicen.

## No hay escrituras directas al alias

El CMS nunca escribe a través de un alias. El `apply` del adaptador rechaza cualquier escritura cuyo destino sea la ruta del alias o cualquier otro artefacto derivado ([`packages/adapter-cerafica/src/index.ts`](../../packages/adapter-cerafica/src/index.ts#L1213-L1223)). Los *symlinks* ni siquiera son visibles para la ruta de escritura: las escrituras se resuelven al objetivo canónico que seleccionó el adaptador, y el alias se verifica, no se authored.

La misma regla aplica a la regeneración. La regeneración es el acto de reestablecer el alias (o volver a verificarlo) tras una escritura canónica. No es una escritura en el artefacto servido. El contrato `alias_symlink` cierra el bucle sin cruzar el límite en sentido inverso.

## La vinculación de productos de Cerafica de un vistazo

| Campo | Valor |
| --- | --- |
| Fuente canónica | `inventory/products.json` |
| Alias servido | `website/data/products.json` |
| Objetivo del alias (declarado) | `../../inventory/products.json` |
| Modo de regeneración | `alias_symlink` (único modo congelado en v1) |
| Fuente de verdad | repositorio del host |
| Destino de escritura al aplicar | solo `inventory/products.json` |

El despliegue de referencia de Cerafica expone tres superficies editables — páginas HTML en duro, la región de productos en JSON estructurado descrita arriba y la API de bitácora Kyanite. Un único adaptador `@cms/adapter-cerafica` media las tres, con la misma forma de solo canónico y alias verificado ([`packages/adapter-cerafica/package.json`](../../packages/adapter-cerafica/package.json)).

## El comercio es *coordinator-gated*

Los campos vinculados al comercio **no** forman parte de la superficie de autoría. Los campos de Cerafica vinculados a Stripe (`price`, `stripe_payment_link`, `available`, `coming_soon`, `one_of_one`) son por defecto de solo lectura / *coordinator-gated*, y `capabilities.coordinator` es el literal congelado `readonly` con `failClosed: true` ([`packages/adapter-cerafica/src/index.ts`](../../packages/adapter-cerafica/src/index.ts#L152-L160), [`docs/overview.es.md`](../overview.es.md)).

La aplicación es **id-matched** en el límite de escritura canónica: cada producto en los bytes propuestos se empareja por id con un producto en los bytes canónicos existentes; los desajustes (ids añadidos o quitados) se rechazan, y las mutaciones del conjunto cerrado de campos de comercio en ids emparejados se rechazan. Cuando el archivo canónico aún no existe, se rechaza introducir productos; una entrada malformada o que no sea un *array* falla de forma cerrada ([`packages/adapter-cerafica/src/index.ts`](../../packages/adapter-cerafica/src/index.ts#L1478-L1582)).

Esto significa:

- El CMS escribe el archivo canónico. No codifica un cambio de comercio.
- Editar libremente `price` sin regenerar el *Payment Link* crearía un desajuste entre el *checkout* y lo mostrado; alternar `available`, `coming_soon` o `one_of_one` sin coordinación de inventario crearía un riesgo de disponibilidad o sobreventa. El límite impide ese camino por construcción.
- La persona coordinadora de comercio sigue siendo la autoridad para las mutaciones de comercio. El CMS muestra el modo de fallo, pero no se convierte en coordinadora.

El mismo control se ejecuta antes de que el escritor de reversión confirme bytes, de modo que la reversión no pueda convertirse en una puerta de elusión contra la autoridad *coordinator-gated* ([`packages/adapter-cerafica/src/index.ts`](../../packages/adapter-cerafica/src/index.ts#L683-L710), [`packages/adapter-cerafica/src/index.ts`](../../packages/adapter-cerafica/src/index.ts#L1024-L1050)).

## Reconciliar es de solo lectura

`reconcile` es una operación de solo lectura. Vuelve a ejecutar la verificación del alias y la comprobación del *hash* canónico; no escribe. `apply` solo escribe canónico y rechaza ejecutarse antes de que la reconciliación haya observado el último estado canónico ([`packages/adapter-sdk/src/index.ts`](../../packages/adapter-sdk/src/index.ts#L33-L44)). El adaptador de Cerafica lo refuerza: `apply` escribe el `inventory/products.json` canónico; `reconcile` vuelve a verificar el alias y el *hash* e informa del estado, nunca de bytes ([`packages/adapter-cerafica/src/index.ts`](../../packages/adapter-cerafica/src/index.ts#L11-L24)).

## La reversión termina en `canonical_written`

Una reversión gobernada es una única acción compensatoria autorizada por una persona. No reproduce credenciales ni suplanta a quien aprobó originalmente, y no emite un recibo "live" sintético. El límite de escritura del adaptador gobernado termina en **`canonical_written`**, no en `live`; el ciclo de vida de la propuesta gobernada transita al estado terminal **`rolled_back`** y se audita como `proposal.rolled_back`. La reconciliación asíncrona del despliegue sigue la escritura canónica e informa por separado si el sitio servido se pone al día ([`packages/core/src/state-machine.ts`](../../packages/core/src/state-machine.ts#L1-L16), [`docs/concepts/governance-and-human-authority.es.md`](governance-and-human-authority.es.md)).

El adaptador de Cerafica lo refleja exactamente: la reversión escribe los bytes canónicos y devuelve `canonical_written`. El ciclo de vida de la propuesta registra el estado terminal `rolled_back`; una reconciliación asíncrona posterior sigue la escritura canónica y no afirma `live` ([`packages/adapter-cerafica/src/index.ts`](../../packages/adapter-cerafica/src/index.ts#L1213-L1238), [`packages/adapter-cerafica/src/index.ts`](../../packages/adapter-cerafica/src/index.ts#L860-L871)).

## Reconciliación asíncrona del despliegue

La propagación en vivo es un momento separado. Una capacidad de despliegue puede informar `succeeded`, `failed` o `cancelled`; esos son estados del recibo de despliegue, no estados de la propuesta. El *trigger* muestra de inmediato un recibo terminal — ninguna devolución `canonical_written` oculta un resultado `failed` o `cancelled`; un recibo terminal malformado lanza una excepción y no deja estado `pending`/`terminal` que una `reconcile` posterior pueda resucitar ([`packages/adapter-cerafica/src/index.ts`](../../packages/adapter-cerafica/src/index.ts#L749-L796)).

Concretamente:

1. `apply` escribe el archivo canónico. La propuesta transita a `canonical_written`.
2. La capacidad de despliegue informa recibo(s) de forma asíncrona. La fila de publicación los registra; la propuesta permanece en `canonical_written` hasta que llegue un recibo terminal.
3. Un recibo `failed` se registra como fallido mientras la propuesta permanece en `canonical_written`. La propuesta no atraviesa silenciosamente un estado `propagating` intermedio que nunca visitó. La fila del recibo es el registro autoritativo del fallo.
4. Un recibo `succeeded` cierra el momento *live*. Hasta que llegue, el estado de despliegue de la propuesta es "despliegue pendiente" desde la perspectiva de la persona autora.

El CMS rastrea `canonical_written` frente a `live`/`live_propagated` y los reconcilia; no los colapsa en un único estado.

## Lo que el host sigue siendo

El repositorio del host sigue siendo la verdad del contenido. Cada byte de contenido y cada recurso vive en el host; Handoff CMS solo posee la proyección gobernada que lo envuelve. El límite se aplica por la topología: un único destino de escritura canónico, una lista cerrada de artefactos derivados, un único modo de regeneración, un contrato de comercio *coordinator-gated* y una máquina de estados que distingue los bytes canónicos de la propagación en vivo. Nada de esto es una afirmación de convergencia de despliegue; lo descrito aquí es el contrato que el sistema aplica cuando toca el host, no una afirmación sobre ningún despliegue en vivo concreto.

## Evidencia

- [`packages/adapter-sdk/src/index.ts`](../../packages/adapter-sdk/src/index.ts) — contrato congelado de `canonical_source` / `derived_artifacts` / `regeneration_contract`; `alias_symlink` es el único modo congelado; `reconcile` es de solo lectura, `apply` solo escribe canónico.
- [`packages/adapter-sdk/src/conformance.ts`](../../packages/adapter-sdk/src/conformance.ts) — arnés de rechazo para rutas `apply` de servicio/agente; sondas de solo lectura y sondas adversariales de `apply`.
- [`packages/core/src/domain.ts`](../../packages/core/src/domain.ts) — tipos de dominio, `E_BAD_REGENERATION_MODE`, `E_EMPTY_DERIVED_ARTIFACTS`.
- [`packages/core/src/state-machine.ts`](../../packages/core/src/state-machine.ts) — `canonical_written` es distinto de `propagating` / `live`; la reversión aterriza en el estado terminal `rolled_back`.
- [`packages/storage/src/schema.ts`](../../packages/storage/src/schema.ts) — columnas jsonb congeladas `canonical_source`, `derived_artifacts[]`, `regeneration_contract`; restricción de comprobación del modo.
- [`packages/storage/migrations/0001_governance.sql`](../../packages/storage/migrations/0001_governance.sql) — invariantes a nivel de tabla, la fila de publicación lleva `canonical_written_at` / `live_at`, la tabla de recibos de despliegue es el registro autoritativo de fallo.
- [`packages/api/src/index.ts`](../../packages/api/src/index.ts) — momentos `canonical_written` y `live_propagated` distintos; un recibo fallido deja la propuesta en `canonical_written`.
- [`packages/adapter-cerafica/src/index.ts`](../../packages/adapter-cerafica/src/index.ts) — comportamiento del adaptador de Cerafica; verificación del alias, escrituras solo canónicas, comercio *coordinator-gated*, `alias_symlink` es el único modo, la reversión termina en `canonical_written`.
- [`packages/adapter-cerafica/src/symlink.ts`](../../packages/adapter-cerafica/src/symlink.ts) — único punto en el que el adaptador inspecciona el *symlink* de productos.
- [`packages/adapter-cerafica/package.json`](../../packages/adapter-cerafica/package.json) — resumen del contrato del host: canónico `inventory/products.json`, alias servido `website/data/products.json`.