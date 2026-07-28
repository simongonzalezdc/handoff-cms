# Adaptador de referencia Cerafica

> **Audiencia:** integradores y autores de adaptadores. Esta página
> es la compañera de referencia de
> [`docs/reference/adapter-sdk.md`](../reference/adapter-sdk.md) ·
> [`.es`](../reference/adapter-sdk.es.md) para el repositorio de
> host Cerafica. Documenta la superficie del adaptador Cerafica tal
> como se envía hoy: el manifiesto `website/cms-regions.json`, el
> inventario canónico de productos `inventory/products.json`, el
> alias de symlink verificado en `website/data/products.json`, el
> mapeo de comercio, el *gating* de coordinador y el mapeo dogfood
> de la superficie del host Cerafica a las exportaciones de
> `@cms/adapter-cerafica`.

> [English version](cerafica.md) · El inglés y el español son locales pares.
> Ambos archivos se publican en el mismo pull request (regla de cero desfase).
> Véase [`../README.es.md#desfase-cero-enes-en-el-mismo-pr`](../README.es.md#desfase-cero-enes-en-el-mismo-pr).

## Manifiesto

El adaptador Cerafica lee un único archivo de manifiesto en
`website/cms-regions.json` al construir el adaptador. El manifiesto
es el contrato cerrado que envía el host; el adaptador rechaza
cargar cualquier valor que no coincida con la forma exactamente.

### Forma del manifiesto (bloqueada: `cms-regions/v1`, versión `1`)

| Campo | Literal | Significado |
| --- | --- | --- |
| `version` | `1` | Única versión de manifiesto aceptada |
| `manifestSchema` | `"cms-regions/v1"` | Único esquema de manifiesto aceptado |
| `host.repo` | `"cerafica"` | Identificador del host |
| `host.deployMode` | `"github_pages"` | Único modo de despliegue aceptado hoy |
| `host.canonicalProductPath` | cadena no vacía | Ruta relativa al repositorio del archivo canónico de productos |
| `host.servedProductPath` | cadena no vacía | Ruta relativa al repositorio del alias servido |
| `regeneration.mode` | `"alias_symlink"` | Único modo de regeneración aceptado |
| `regeneration.source` | cadena no vacía | Ruta relativa al repositorio a la que resuelve el alias servido (típicamente la ruta canónica) |
| `regeneration.target` | cadena no vacía | Ruta relativa al repositorio a la que apunta el alias servido (resuelta contra el directorio del alias) |
| `regeneration.readonly` | `true` | Único valor aceptado |
| `capabilities.journal.provider` | cadena no vacía | Identificador del proveedor de bitácora |
| `capabilities.journal.mode` | `"readonly"` | Único modo aceptado |
| `capabilities.journal.source` | `"discovered"` | Único origen aceptado |
| `capabilities.journal.module` | cadena no vacía | Ruta relativa al repositorio del módulo de bitácora que el adaptador puede descubrir |
| `capabilities.fields` | objeto indexado por campo de comercio | Cada entrada DEBE tener `mode: "readonly"` |
| `capabilities.coordinator` | `"readonly"` | Único valor aceptado |
| `capabilities.failClosed` | `true` | Único valor aceptado |
| `localization.altPolicy.mode` | `"peer-required"` | Único modo aceptado |
| `localization.altPolicy.languages` | `["en", "es"]` | Único par ordenado aceptado |
| `localization.altPolicy.hostCopyLanguage` | `"en"` | Único valor aceptado |
| `anchors.home.heroText` | cadena no vacía | Copia del héroe en la página de inicio |
| `anchors.home.featuredImage.id` | cadena no vacía | Identificador del activo de imagen destacada |
| `anchors.home.featuredImage.alt` | cadena no vacía | Texto alternativo de la imagen destacada |
| `anchors.home.sections.container` | cadena no vacía | Selector del contenedor de secciones |
| `anchors.home.sections.section` | cadena no vacía | Selector de una sección individual |
| `anchors.shop.productCollection.container` | cadena no vacía | Selector del contenedor de la colección de productos |

`parseManifest(value)` rechaza cualquier valor cuya forma, claves o
literales no coincidan. El validador surface los errores como
`ManifestValidationError(field, message)`; el adaptador envuelve los
fallos de carga del manifiesto como `AdapterContractError` con
`E_BINDING_NOT_FOUND` y `details.manifestPath`.

Fuente: `packages/adapter-cerafica/src/index.ts:126-573`.

## Inventario canónico de productos

La única superficie editable del adaptador Cerafica es el archivo
canónico de productos. El repositorio Cerafica enviado lo
almacena en `inventory/products.json`; el
`host.canonicalProductPath` del manifiesto declara esta ruta y el
adaptador la trata como la única fuente de verdad.

La forma del archivo es un arreglo JSON de nivel superior con
registros de producto. Cada registro lleva como mínimo:

- `id` — una cadena única y no vacía. El id es la clave de join
  usada por la comprobación de *gating* de comercio con coincidencia
  por id. Los ids duplicados o faltantes fallan cerrados con
  `E_BINDING_NOT_FOUND` y
  `details.repoPath === <canonicalRelPath>`.
- `stripe_payment_link`, `price`, `available`, `coming_soon`,
  `one_of_one` — el conjunto cerrado de campos de comercio. El
  adaptador los aplica como puerta de coordinador en el límite de
  aplicar.

Los campos descriptivos y de imagen seguros siguen siendo
editables: título, slug, descripción, identificadores de imagen,
texto alternativo, orden de clasificación, taxonomía y cualquier
metadato definido por el host que no se solape con el conjunto
cerrado de comercio.

El adaptador materializa la carga aprobada en un `Buffer` y escribe esos bytes
sin modificarlos en el archivo canónico; no analiza ni vuelve a serializar JSON
durante la escritura. Las comprobaciones de comercio y confinamiento se
ejecutan antes de escribir. Una aplicación exitosa devuelve el digest sha256
de los mismos bytes materializados, que el sistema audita como hash canónico.

Fuente: `packages/adapter-cerafica/src/index.ts:1227-1246`,
`packages/adapter-cerafica/src/index.ts:1392-1395` y
[`docs/concepts/content-boundary.es.md`](../concepts/content-boundary.es.md).

## Alias de symlink verificado

`website/data/products.json` es un **symlink del sistema de
archivos**, no un archivo regular. El repositorio Cerafica lo envía
apuntando a `../../inventory/products.json` (resuelto contra el
directorio del alias). En la activación y en cada reconciliación,
el adaptador verifica el alias mediante `verifyAlias`
(`packages/adapter-cerafica/src/symlink.ts`).

El verificador realiza, en orden:

1. `lstat` sobre la ruta del alias. Una entrada faltante falla con
   `E_ALIAS_MISSING`; una entrada que no es symlink falla con
   `E_ALIAS_NOT_SYMLINK`.
2. `readlink` sobre la ruta del alias y captura la cadena.
3. Recorre la cadena mediante llamadas reales a `readlink`,
   detectando bucles con un contador acotado de saltos
   (`MAX_SYMLINK_HOPS = 40`) y detectando rutas que escapan
   mediante realpath.
4. Compara la ruta absoluta canónica resuelta con el destino
   declarado. Una no coincidencia falla con `E_ALIAS_RETARGETED`.
5. `readFile` sobre la ruta canónica y calcula su digest sha256 hex.
   El digest se expone para que reconciliar pueda volver a
   comprobarlo sin re-leer los bytes.

El verificador rechaza cualquiera de las siguientes formas:

| Forma | Código de rechazo de symlink |
| --- | --- |
| La entrada del alias no existe | `E_ALIAS_MISSING` |
| La entrada del alias existe pero no es un symlink | `E_ALIAS_NOT_SYMLINK` |
| Una llamada `readlink` o `realpath` falla | `E_ALIAS_BROKEN` |
| El alias resuelve a una ruta distinta del destino declarado | `E_ALIAS_RETARGETED` |
| La cadena del alias resuelve fuera de la raíz del repositorio | `E_ALIAS_ESCAPING` |
| La cadena del alias excede `MAX_SYMLINK_HOPS` o forma un bucle | `E_ALIAS_LOOPED` |
| El archivo canónico falta o no es legible | `E_CANONICAL_MISSING` |

Estos son los códigos de rechazo específicos de symlink exportados
por la constante `SYMLINK_REFUSAL_CODES` desde
`packages/adapter-cerafica/src/symlink.ts`. El adaptador mapea cada
rechazo de symlink a un código de rechazo de SDK cerrado mediante
`mapSymlinkRefusalToAdapterCode`. Hoy el mapeo es cerrado y
exhaustivo: cada rechazo de symlink mapea a `E_AMBIGUOUS_BINDING`,
y el código de symlink original se preserva en
`AdapterContractError.details.symlinkCode`. Deliberadamente **no**
hay un código `E_ALIAS_HASH_MISMATCH` en ninguna unión: el contrato
del verificador declarado no aporta un hash esperado, por lo que un
código de rechazo con ese nombre nunca podría producirse. Dejarlo
sería o bien una cadena muerta o bien un error de programación.

La unión cerrada `SYMLINK_REFUSAL_CODES` es:

```ts
export const SYMLINK_REFUSAL_CODES = [
  'E_ALIAS_MISSING',
  'E_ALIAS_BROKEN',
  'E_ALIAS_NOT_SYMLINK',
  'E_ALIAS_RETARGETED',
  'E_ALIAS_ESCAPING',
  'E_ALIAS_LOOPED',
  'E_CANONICAL_MISSING',
] as const;
```

Fuente: `packages/adapter-cerafica/src/symlink.ts:33-58`,
`packages/adapter-cerafica/src/symlink.ts:340-368`.

## Códigos de rechazo de symlink por el símbolo `SYMLINK_REFUSAL_CODES`

El adaptador Cerafica expone la unión de rechazos específica de
symlink mediante la constante en tiempo de ejecución
`SYMLINK_REFUSAL_CODES` y el alias de tipo `SymlinkRefusalCode`
derivado de ella. El arnés y el adaptador consultan esta unión
directamente. El mapeo de rechazo de symlink a rechazo de SDK es la
función cerrada `mapSymlinkRefusalToAdapterCode`:

| Rechazo de symlink (`SYMLINK_REFUSAL_CODES`) | Rechazo de SDK (`ADAPTER_REFUSAL_CODES`) |
| --- | --- |
| `E_ALIAS_MISSING` | `E_AMBIGUOUS_BINDING` |
| `E_ALIAS_BROKEN` | `E_AMBIGUOUS_BINDING` |
| `E_ALIAS_NOT_SYMLINK` | `E_AMBIGUOUS_BINDING` |
| `E_ALIAS_RETARGETED` | `E_AMBIGUOUS_BINDING` |
| `E_ALIAS_ESCAPING` | `E_AMBIGUOUS_BINDING` |
| `E_ALIAS_LOOPED` | `E_AMBIGUOUS_BINDING` |
| `E_CANONICAL_MISSING` | `E_AMBIGUOUS_BINDING` |

`AdapterContractError` lleva el código de symlink en
`details.symlinkCode` y el código de SDK como `code`. El mapeo es
la traducción cerrada única entre las uniones cerradas de
códigos de rechazo específicas de symlink y del SDK.

Fuente: `packages/adapter-cerafica/src/symlink.ts:340-368`.

## Escrituras solo canónicas

El adaptador Cerafica escribe **solo** en la ruta canónica
declarada por `host.canonicalProductPath` del manifiesto. El sistema
nunca escribe a través del alias de symlink. En el momento de
aplicar, el adaptador rechaza cualquier escritura cuyo destino sea:

- La ruta del alias (`website/data/products.json`) —
  `E_ALIAS_WRITE_FORBIDDEN`.
- Cualquier entrada de `derived_artifacts[]` de la vinculación —
  `E_DERIVED_WRITE_FORBIDDEN`.
- Una ruta que no es el `regeneration.source` del manifiesto —
  `E_DERIVED_WRITE_FORBIDDEN`.
- Una ruta absoluta o una ruta que contiene segmentos `..` — el
  adaptador las rechaza antes de que ocurra cualquier trabajo del
  host (`E_DERIVED_WRITE_FORBIDDEN`).

El límite de aplicar además exige coincidencia de binding-id y
entorno:

- Una escritura cuyo `bindingId` no coincide con la vinculación
  activada se rechaza con `E_BINDING_NOT_FOUND`.
- Una escritura cuyo `environment` no coincide con el entorno de la
  vinculación se rechaza con `E_ENVIRONMENT_MISMATCH`.
- Una escritura cuyo `actor` es una identidad de servicio o de
  agente se rechaza con `E_AUTHORITY_FORBIDDEN`. El adaptador
  Cerafica consulta `isServiceIdentity` desde `@cms/core` para esta
  comprobación; tanto las identidades de servicio como las de
  agente con forma MCP son rechazadas.

Fuente: `packages/adapter-cerafica/src/index.ts:1183-1244`,
`docs/reference/adapter-sdk.md` ·
[`.es`](../reference/adapter-sdk.es.md).

## Mapeo de comercio

El adaptador Cerafica anuncia un conjunto cerrado de campos de
comercio derivado del objeto `capabilities.fields` del manifiesto.
El mapeo es la única fuente de verdad de cómo llama el host a cada
campo de comercio y qué aplica el adaptador.

| Etiqueta anunciada | Claves JSON del host (en `inventory/products.json` canónico) |
| --- | --- |
| `stripe` | `stripe_payment_link` |
| `payment` | `stripe_payment_link` |
| `price` | `price` |
| `availability` | `available`, `coming_soon` |
| `one_of_one` | `one_of_one` |

El conjunto `CommerceField` anunciado (manifiesto
`capabilities.fields`, la instantánea de `fieldCapabilities()` y la
iteración de `enforceCommerceFieldGating`) se deriva de este
mapeo. No hay una lista divergente de claves de esquema en ninguna
otra parte del adaptador; el esquema del host es autoritativo y
este mapeo solo nombra la rebanada que el adaptador cierra.

El conjunto cerrado `ENFORCED_HOST_KEYS`, deduplicado en orden de
primera aparición, es:

```
stripe_payment_link, price, available, coming_soon, one_of_one
```

(`stripe` y `payment` ambos mapean a `stripe_payment_link`; el
adaptador deduplica preservando el orden estable para que los
mensajes de rechazo se mantengan estables entre ejecuciones.)

Fuente: `packages/adapter-cerafica/src/index.ts:188-250`,
`packages/adapter-cerafica/src/index.ts:1467-1582`.

## *Gating* de coordinador de comercio

El adaptador Cerafica aplica el *gating* de comercio en el límite
de escritura canónica mediante una comprobación **con coincidencia
por id**:

1. El adaptador lee el archivo canónico existente (o lo trata como
   vacío si está ausente).
2. El adaptador parsea los bytes propuestos como JSON.
3. El adaptador empareja productos por id. Los ids duplicados o
   faltantes fallan cerrados con `E_BINDING_NOT_FOUND`.
4. Cualquier id del conjunto propuesto que no esté en el conjunto
   existente (`added`) se rechaza. Cualquier id del conjunto
   existente que no esté en el conjunto propuesto (`removed`) se
   rechaza. La primera escritura, cuando el archivo canónico aún
   no existe, se trata como "ningún producto puede introducirse" —
   añadir un producto se rechaza.
5. Para cada id emparejado, las mutaciones del conjunto cerrado
   `ENFORCED_HOST_KEYS` se rechazan.

Códigos de rechazo:

| Condición | Código |
| --- | --- |
| Ids de producto añadidos o eliminados | `E_DERIVED_WRITE_FORBIDDEN` (`details.commerceGating === 'add_remove'`) |
| Mutación de cualquier campo de comercio en un id emparejado | `E_DERIVED_WRITE_FORBIDDEN` (`details.commerceGating === 'field'`) |
| Primera escritura sin archivo existente y cualquier producto en los bytes propuestos | `E_DERIVED_WRITE_FORBIDDEN` (tratado como añadir/eliminar) |

Los campos descriptivos y de imagen seguros siguen siendo
editables. El coordinador de comercio sigue siendo la autoridad
para las mutaciones de comercio; el CMS expone el modo de fallo
pero no se convierte en coordinador.

El mismo *gating* se ejecuta antes de que el escritor de reversión
confirme cualquier byte mediante el hook
`RollbackSafetyOptions.safetyCheck`, de modo que una reversión no
puede convertirse en una escotilla de bypass contra la autoridad
de puerta de coordinador. El confinamiento al repositorio en la
ruta de reversión refleja la ruta de aplicar mediante `isConfined`
(un duplicado léxico de `joinInsideRepo`): cuando se configura un
`repoRoot`, la reversión rechaza un `canonicalPath` que resuelve
fuera de la raíz del repositorio.

Fuente: `packages/adapter-cerafica/src/index.ts:683-873`,
`packages/adapter-cerafica/src/index.ts:1467-1582`,
`docs/concepts/content-boundary.md`.

## Capacidad de despliegue (consultiva)

El adaptador Cerafica expone un `DeployCapability` de tipo
`cache.invalidate`, habilitado cuando `host.deployMode` del
manifiesto es `github_pages`. La capacidad es **consultiva**:
dispara un `GitHubPagesDeployClient` inyectado por el host e
informa del estado del recibo, pero nunca reclama autoridad sobre
aplicar, publicar o revertir.

Máquina de estados de la capacidad de despliegue:

| Estado | Cuándo se observa |
| --- | --- |
| `canonical_written` | El disparador retorna de inmediato y el recibo es no terminal; la propuesta está en `canonical_written` |
| `awaiting_receipt` | La reconciliación sondeó un recibo no terminal |
| `succeeded` | Recibo terminal con `status: "succeeded"`, `finishedAt` y `url` |
| `failed` | Recibo terminal con `status: "failed"` o `"cancelled"`, `finishedAt` y `message`; los recibos cancelados se proyectan al estado de capacidad `failed` |

Un recibo `failed` o `cancelled` en el momento del disparo se expone
**directamente** — el disparador no lo oculta detrás de un retorno
`canonical_written`. Un recibo terminal mal formado observado al
disparar o reconciliar lanza mediante `receiptToState`. Un fallo al disparar no
deja estado pendiente ni terminal. Un fallo al reconciliar conserva el recibo
pendiente para que la siguiente reconciliación lo sondee y valide de nuevo;
ninguna ruta fabrica éxito.

El adaptador Cerafica no llama a una red directamente. El cliente
de despliegue se inyecta al construir el adaptador; no hay
*fallback* de red.

Fuente: `packages/adapter-cerafica/src/index.ts:604-873`.

## La reversión termina en `canonical_written`

La ruta de reversión del adaptador Cerafica escribe los bytes
canónicos y retorna `{ kind: 'canonical_written' }`. El ciclo de
vida de propuesta gobernada transiciona a `rolled_back` terminal y
se audita como `proposal.rolled_back`; la reconciliación de
despliegue asíncrona sigue a la escritura canónica y no reclama
`live`. Una reversión también restablece cualquier estado de
despliegue `pending` / `terminal` obsoleto porque los bytes
canónicos ya no son autoritativos para el despliegue en vivo.

La seguridad de la reversión se aplica mediante:

- Una comprobación de confinamiento al repositorio sobre
  `canonicalPath` contra el `repoRoot` configurado.
- La misma comprobación `enforceCommerceFieldGating` que aplica la
  ruta de aplicar, instalada mediante
  `RollbackSafetyOptions.safetyCheck`.
- Una comparación de digest sha256 hex de los bytes de aprobación
  contra `RollbackInput.approvalHash`. Una no coincidencia lanza
  `RollbackApprovalHashMismatchError` y el escritor no se invoca.

Fuente: `packages/adapter-cerafica/src/index.ts:677-873`,
`docs/concepts/content-boundary.md`.

## Bitácora (descubrimiento de solo lectura, sin escrituras)

El adaptador Cerafica expone la bitácora solo mediante
descubrimiento. El adaptador devuelve el proveedor de la bitácora,
las rutas relativa y absoluta del módulo y el literal `readonly:
true` desde `discoverJournal()`. El adaptador nunca escribe la
bitácora: `journalWrite()` rechaza con
`JournalWriteUnsupportedError`. Cualquier intento de usar la
bitácora como superficie de escritura es un error de programación, y
el rechazo del adaptador es la única respuesta correcta.

Fuente: `packages/adapter-cerafica/src/index.ts:1297-1316`.

## Mapeo dogfood: superficie del host a `@cms/adapter-cerafica`

El repositorio Cerafica es también el despliegue *dogfood* de
referencia del sistema de documentación. El mapeo de abajo lista
cada superficie del host Cerafica mediada hoy y los símbolos de implementación
involucrados. Los símbolos pueden ser exportaciones públicas o helpers privados;
la tabla describe propiedad del código, no una API pública. Lo no listado queda fuera de V1.

| Superficie del host | Símbolo(s) mediador(es) | Comportamiento |
| --- | --- | --- |
| `website/cms-regions.json` | `loadManifest`, `parseManifest`, `manifestToActivationContract` | Leído al construir el adaptador; el manifiesto cerrado es el contrato que aplica el adaptador |
| `inventory/products.json` (canónico) | `apply`, `reconcile`, `materialiseBytes`, `enforceCommerceFieldGating` | Única ruta canónica escribible. Las escrituras están protegidas por la aplicación de comercio con coincidencia por id |
| `website/data/products.json` (alias de symlink verificado) | `verifyAlias`, `walkChain`, `SYMLINK_REFUSAL_CODES` | Verificado, nunca escrito. Cualquiera de los siete códigos de rechazo de symlink cierra la activación |
| API de bitácora Kyanite | `discoverJournal`, `journalWrite` | Solo descubrimiento; escrituras rechazadas con `JournalWriteUnsupportedError` |
| Despliegue en GitHub Pages | `createGitHubPagesDeployCapability`, `deployCapabilitySnapshot`, `DeployCapabilityState` | Capacidad de despliegue consultiva; `cache.invalidate` habilitado cuando `host.deployMode === 'github_pages'` |
| Campos de comercio (`stripe`, `payment`, `price`, `availability`, `one_of_one`) | `COMMERCE_FIELD_HOST_KEYS`, `ENFORCED_HOST_KEYS`, `enforceCommerceFieldGating` | Puerta de coordinador; los códigos de rechazo con coincidencia por id llevan `details.commerceGating` |
| Páginas HTML (`index.html`, `pages/*.html`) | fuera del alcance de V1 | Superficies de host estáticas; sin ruta de escritura canónica |
| Anclas bilingües (`altPolicy: peer-required`) | `localization.altPolicy` | Declaradas en el manifiesto; el adaptador las expone pero no traduce |

Un adaptador Cerafica se construye con
`createCeraficaAdapter(options)`. Las opciones requeridas son
`repoRoot`, `manifestPath`, `deployClient` y `rollbackWriter`; los
campos opcionales sobreescriben `tenantId`, `environment` y
`locale`. El adaptador expone `fieldCapabilities()`,
`deployCapability()` y `deployCapabilitySnapshot()` como extensiones
provisionales.

Fuente: `packages/adapter-cerafica/src/index.ts:914-1053`,
`packages/adapter-cerafica/src/index.ts:1596-1619`.

## Restricciones abiertas

El segundo adaptador es la **puerta de conformidad de v1.1**, no
una afirmación de completitud de V1. El adaptador Cerafica es la
única implementación de referencia que envía V1. Los campos de
extensión específicos del host del SDK siguen siendo provisionales
(`1.0.0-rc.1`) hasta que un segundo adaptador los ejercite; el
adaptador Cerafica los ejercita, pero un único host no es
suficiente para graduar las extensiones fuera de `1.0.0-rc.1`
según el contrato del SDK. Véase
[`docs/overview.es.md`](../overview.es.md) · [English](../overview.md) y
[`docs/evidence/limitations.md`](../evidence/limitations.md).

El adaptador Cerafica nunca escribe a través del alias de symlink.
Nunca aprueba, nunca publica y nunca decide revertir. La capacidad
de despliegue es consultiva y opera contra un cliente inyectado; no
hay *fallback* de red. Los campos de comercio son puerta de
coordinador; el CMS expone el modo de fallo pero no se convierte en
coordinador.