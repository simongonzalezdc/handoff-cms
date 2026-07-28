# SDK del adaptador

> **Audiencia:** integradores y autores de adaptadores. Esta página es
> la referencia cerrada del contrato de `@cms/adapter-sdk` — la forma
> congelada portadora de invariantes que cada adaptador de host
> implementa. Es de carácter informativo (referencia Diátaxis):
> refleja línea por línea la unión en tiempo de ejecución en
> `packages/adapter-sdk/src/index.ts` y el arnés en
> `packages/adapter-sdk/src/conformance.ts`. La guía procedural para
> el adaptador que se envía hoy vive en la página compañera
> [`docs/adapters/cerafica.md`](../adapters/cerafica.md) ·
> [`.es`](../adapters/cerafica.es.md).

> [English version](adapter-sdk.md) · English and Spanish are peer
> locales. Both siblings ship in the same pull request (zero-lag
> rule). See [`../README.md#same-pr-enes-zero-lag`](../README.md#same-pr-enes-zero-lag).

## Qué es el SDK

`@cms/adapter-sdk` es el contrato público que conecta un repositorio
de host con el sistema. Es deliberadamente **libre de E/S**: solo
describe formas, contratos y límites. Los adaptadores toman esas
formas, realizan el trabajo del host y devuelven los recibos
definidos por el sistema. El SDK nunca abre un archivo, ejecuta un
comando del shell ni contacta una red.

El SDK divide su superficie en un **núcleo congelado** (semver
`1.0.0`) y unas **extensiones provisionales** (`1.0.0-rc.1`). La
línea mayor es el único campo que se compara; `provisional` y
`extensions` son informativos.

| Superficie | Versión | Estado |
| --- | --- | --- |
| Núcleo congelado | `1.0.0` | Los cambios incompatibles requieren un salto de mayor |
| Extensiones | `1.0.0-rc.1` | Se admiten cambios incompatibles dentro de `1.0.0` |
| Identificador de superficie | `@cms/adapter-sdk` | Cadena que cada declaración de contrato de adaptador debe repetir |

Fuente: `packages/adapter-sdk/src/index.ts:96-129`
(`AdapterContractVersion`, `ADAPTER_SDK_FROZEN_VERSION`,
`ADAPTER_SDK_EXTENSIONS_VERSION`, `ADAPTER_SDK_SURFACE`,
`ADAPTER_FROZEN_CORE_METADATA`).

## Invariante de autoridad

La superficie del adaptador es una **superficie de escritura**, no
una superficie de autoridad. Aprobar, publicar y revertir son del
lado del sistema y nunca se delegan a rutas de adaptador. El SDK
aplica esto al negarse a exponer cualquier primitiva de aprobación,
publicación, aplicación-en-nombre-de o reversión a través de
`apply`. Los adaptadores exponen solo la intención de escritura
canónica y el recibo correspondiente; el sistema decide si
proteger, aprobar, publicar o revertir.

Concretamente:

- Las identidades de servicio y de agente son rechazadas en `apply`
  con `E_AUTHORITY_FORBIDDEN`. El arnés lo verifica sobre un
  adaptador en vivo.
- Aprobar / publicar / revertir no son métodos del adaptador. Viven
  del lado del sistema en el límite.
- `DeployCapability` es consultiva. La capacidad puede reportar un
  recibo de despliegue; no puede reclamar autoridad sobre los
  pulsos de aplicar, publicar o revertir.

Fuente: `packages/adapter-sdk/src/index.ts:46-52`,
`packages/adapter-sdk/src/conformance.ts:660-694`.

## Identidad del adaptador

Los adaptadores se identifican con una cadena `AdapterId`
namespacada con la forma `@cms/adapters/<host>`. El sistema nunca
hace coincidir patrones sobre el segmento de host para decisiones
de seguridad; el segmento de host es informativo y se usa solo
para enrutamiento.

```ts
import { brandAdapterId, type AdapterId } from '@cms/adapter-sdk';

const adapterId: AdapterId = brandAdapterId('@cms/adapter-cerafica');
```

El constructor de marca es un `string & { readonly __brand:
'AdapterId' }` que rechaza cadenas vacías en tiempo de construcción.
El campo `contract` del adaptador es la única declaración del núcleo
congelado:

```ts
import {
  ADAPTER_SDK_VERSION,
  type Adapter,
  type AdapterContractVersion,
} from '@cms/adapter-sdk';

const contract: AdapterContractVersion = ADAPTER_SDK_VERSION;
```

Fuente: `packages/adapter-sdk/src/index.ts:135-147`.

## Contrato congelado de `RegionBinding`

El `RegionBinding` congelado de `@cms/core` es el único descriptor
que un adaptador recibe. El SDK reexporta sus tres campos
congelados de forma literal:

| Campo (canónico / JSON) | Campo (TS) | Congelado | Notas |
| --- | --- | --- | --- |
| `canonical_source` | `canonicalSource` | sí | Ruta única del host a la que apunta la vinculación |
| `derived_artifacts` | `derivedArtifacts` | sí | Lista cerrada no vacía de rutas servidas |
| `regeneration_contract` | `regenerationContract` | sí | Un único modo hoy: `alias_symlink` |

`ADAPTER_FROZEN_CORE_METADATA` publica la lista cerrada de
`regionBindingContractFields`, `typeScriptProperties` y
`regenerationModes` para que las herramientas aguas abajo puedan
introspectar la superficie congelada sin analizar TypeScript.

Fuente: `packages/adapter-sdk/src/index.ts:115-129`,
`packages/core/src/domain.ts`.

## Descubrimiento de capacidades (solo lectura)

El descubrimiento es un **anuncio de solo lectura**. El adaptador
responde dos preguntas: qué capacidades congeladas y provisionales
admite esta implementación de host de forma fiable, y para cada
vinculación, si la vinculación es inequívoca en este entorno.

### Capacidades congeladas (`AdapterCapability`)

El conjunto congelado de capacidades es cerrado. Cualquier cosa
fuera de él falla cerrada en la activación.

```ts
export type AdapterCapability =
  | 'canonical.read'
  | 'canonical.write'
  | 'derived.regenerate'
  | 'media.alias_symlink'
  | 'media.transcode'
  | 'binding.discover'
  | 'binding.activate'
  | 'binding.reconcile'
  | 'binding.apply';
```

### Capacidades provisionales (`ProvisionalCapability`)

El conjunto provisional también es cerrado. El arnés los reporta
como provisionales y el sistema trata cualquier efecto secundario
que desbloqueen como experimental.

```ts
export type ProvisionalCapability =
  | 'field.capabilities.read'
  | 'field.capabilities.write'
  | 'deploy.receipt';
```

### Resultado del descubrimiento

`discover(input)` devuelve un `AdapterDiscovery`:

| Campo | Tipo | Significado |
| --- | --- | --- |
| `adapterId` | `AdapterId` | Identidad del adaptador |
| `contract` | `AdapterContractVersion` | Declaración de congelado / extensiones / superficie |
| `frozenCapabilities` | `readonly AdapterCapability[]` | Subconjunto del conjunto cerrado que el host admite con fiabilidad |
| `provisionalCapabilities` | `readonly ProvisionalCapability[]` | Subconjunto del conjunto cerrado que el host admite, marcado como provisional |
| `candidates` | `readonly AdapterDiscoveryCandidate[]` | Preparación de activación por vinculación |

Un `candidate` con un arreglo `issues` vacío significa que la
vinculación es inequívoca y puede pasar a activación. Un arreglo
`issues` no vacío significa que el arnés DEBE rechazar la
activación.

Fuente: `packages/adapter-sdk/src/index.ts:149-216`.

## Activación

La activación convierte una vinculación descubierta en una
instancia de adaptador en vivo e inequívoca. El arnés requiere
`ok === true` para considerar la activación completa.

Campos de `AdapterActivation`:

| Campo | Significado |
| --- | --- |
| `adapterId`, `bindingId`, `tenantId`, `environment` | Identidad repetida desde la vinculación |
| `ok` | `true` cuando la activación tuvo éxito |
| `refusalReasons` | Motivos de rechazo legibles por humanos; vacío cuando `ok === true` |
| `enabledCapabilities` | Capacidades del conjunto cerrado que la activación habilitó para esta vinculación |
| `contract` | Instantánea de `AdapterActivationContract` del contrato de regeneración resuelto |

Un `AdapterActivationContract` lleva la ruta de alias resuelta, los
destinos de alias, el modo de regeneración y la ruta canónica del
repositorio. Cuando `ok === false`, este campo sigue reflejando el
contrato que el adaptador habría usado para que el arnés pueda
auditar la ambigüedad.

La activación se rechaza cuando:

- `derived_artifacts[]` está vacío.
- `regeneration_contract.mode` no es `alias_symlink`.
- Un artefacto derivado colisiona con la ruta de la fuente canónica.
- Los destinos del alias colisionan con la ruta de la fuente
  canónica más de una vez.
- La ruta del alias es autorreferencial o escapa de la raíz del
  repositorio.

Fuente: `packages/adapter-sdk/src/index.ts:218-250`,
`packages/adapter-sdk/src/conformance.ts:413-492`.

## Reconciliación (chequeo de deriva idempotente, sin escrituras)

Reconciliar compara la fuente canónica con los artefactos servidos o
derivados e informa si están en sincronía. Reconciliar **NO DEBE**
mutar el estado del host. El recibo es lo único que devuelve.

`AdapterReconcileReceipt`:

| Campo | Significado |
| --- | --- |
| `adapterId`, `bindingId`, `tenantId`, `environment` | Identidad repetida desde la vinculación |
| `observedAt` | Marca temporal `Iso8601` de la observación |
| `inSync` | `true` si y solo si cada artefacto derivado coincide con el estado canónico |
| `drift` | `readonly AdapterDriftEntry[]` — diferencias declarado-vs-observado por artefacto |

Una entrada de `drift` describe un artefacto cuyo hash actual difiere
del hash que la vinculación declaró. Reconciliar es observacional; el
adaptador nunca intenta reparar la deriva desde esta llamada.

Reconciliar es la condición previa aguas arriba para `apply`: apply
se niega a ejecutarse antes de que reconciliar haya observado el
último estado canónico.

Fuente: `packages/adapter-sdk/src/index.ts:252-282`.

## Aplicar (intención de escritura solo canónica)

Apply es la **intención de escritura solo canónica**. El SDK define
la forma; el adaptador realiza el trabajo del host.

`CanonicalWrite`:

| Campo | Significado |
| --- | --- |
| `adapterId`, `bindingId`, `tenantId`, `environment` | Identidad repetida desde la vinculación |
| `target.repoPath` | La ruta de la fuente canónica. **NO DEBE** ser un artefacto derivado ni la ruta del alias |
| `target.contract` | `AdapterActivationContract` que el adaptador debe obedecer |
| `bytes` | `AdapterWritePayload` (texto `utf8` o datos `base64`) |
| `actor` | `Identity` que conduce la escritura |
| `contentHash?` | Hash de contenido opcional capturado por el host |

`AdapterApplyReceipt` repite el contrato que se aplicó, la ruta
canónica del repositorio que se materializó, el hash canónico, la
marca temporal aplicada y el actor. El sistema audita este recibo;
el adaptador nunca devuelve decisiones de autoridad desde esta
llamada.

La regla congelada: `target.repoPath` DEBE ser la ruta de la fuente
canónica. Cualquier solicitud cuyo destino sea una ruta de artefacto
derivado se rechaza con `E_DERIVED_WRITE_FORBIDDEN`; cualquier
solicitud cuyo destino sea la ruta del alias se rechaza con
`E_ALIAS_WRITE_FORBIDDEN`. Ambos se rechazan antes de que ocurra
cualquier trabajo del host.

Fuente: `packages/adapter-sdk/src/index.ts:284-345`.

## Interfaz del adaptador

Cada implementación de host satisface la misma forma `Adapter`:

```ts
export interface Adapter {
  readonly id: AdapterId;
  readonly contract: AdapterContractVersion;
  discover(input: DiscoverInput): Promise<AdapterDiscovery>;
  activate(input: ActivateInput): Promise<AdapterActivation>;
  reconcile(input: ReconcileInput): Promise<AdapterReconcileReceipt>;
  apply(input: CanonicalWrite): Promise<AdapterApplyReceipt>;
}
```

El comportamiento específico del producto vive en la implementación,
no en el contrato. El arnés trata cualquier desviación como un
incumplimiento del contrato.

Fuente: `packages/adapter-sdk/src/index.ts:347-388`.

## Extensiones provisionales (`1.0.0-rc.1`)

Dos superficies específicas del host son provisionales y pueden
moverse dentro de la línea mayor `1.0.0`.

### Capacidades por campo

`FieldCapabilityValue` es un conjunto cerrado de literales:

| Valor | Significado |
| --- | --- |
| `read_only` | Campo expuesto para visualización; sin edición a través de la superficie de autoría |
| `coordinator_gated` | Ediciones protegidas por un coordinador específico del host; el sistema solo reenvía la intención |
| `free_edit` | Ediciones fluyen por la ruta de escritura canónica sin coordinación adicional del host |

`FieldCapabilitiesSnapshot` es lo que un adaptador devuelve desde la
capacidad provisional `field.capabilities.read`. El núcleo congelado
no interpreta estos valores; el sistema lee el valor para elegir el
punto de entrada; el adaptador hace cumplir el cumplimiento.

### Capacidad de despliegue

`DeployCapabilityKind` es un conjunto cerrado de literales:

| Valor | Significado |
| --- | --- |
| `cdn.purge` | Integración de purga de CDN |
| `search.reindex` | Reindexado del índice de búsqueda |
| `marketing.notify` | Notificación al sistema de marketing |
| `cache.invalidate` | Invalidación de caché |

`DeployCapability` es puramente consultiva. El sistema posee la
aprobación, publicación y reversión; un adaptador que expone esta
capacidad NO DEBE usarla para reclamar autoridad sobre esas
acciones. Las capacidades deshabilitadas se siguen anunciando para
que el sistema pueda razonar sobre paridad, pero son no-op.

Fuente: `packages/adapter-sdk/src/index.ts:390-470`.

## Unión cerrada de códigos de rechazo

El SDK expone una unión cerrada de códigos de rechazo mediante la
constante en tiempo de ejecución `ADAPTER_REFUSAL_CODES`. Los
llamadores hacen pattern matching sobre `code`; `message` es solo
para humanos. La unión cerrada es el contrato legible por máquina;
el alias de tipo `AdapterRefusalCode` se deriva de la constante
mediante `typeof ADAPTER_REFUSAL_CODES[number]`.

| Código | Cuándo lo devuelve el SDK |
| --- | --- |
| `E_AMBIGUOUS_BINDING` | Activación rechazada porque la vinculación es ambigua (más de un puntero canónico a la misma ruta, destino de alias autorreferencial, destino de alias que colisiona con la ruta de la fuente canónica, artefactos derivados vacíos o un contrato regenerado que no repite la vinculación) |
| `E_DERIVED_WRITE_FORBIDDEN` | `apply` rechazado porque el destino de la escritura es una ruta de artefacto derivado o escapa de la raíz del repositorio |
| `E_ALIAS_WRITE_FORBIDDEN` | `apply` rechazado porque el destino de la escritura es la ruta del alias |
| `E_UNSUPPORTED_CAPABILITY` | Activación rechazada porque el adaptador anunció una capacidad fuera del conjunto congelado cerrado |
| `E_CONTRACT_VERSION_MISMATCH` | Activación rechazada porque el mayor congelado del adaptador no coincide con el mayor congelado del SDK |
| `E_PROVISIONAL_OUT_OF_SCOPE` | Activación rechazada porque el adaptador anunció una capacidad provisional que no ha habilitado explícitamente |
| `E_AUTHORITY_FORBIDDEN` | `apply` rechazado porque el actor es una identidad de servicio o agente |
| `E_BINDING_NOT_FOUND` | `apply` rechazado porque la vinculación no fue descubierta ni activada, o no se pudo leer el manifiesto / la fuente canónica |
| `E_ENVIRONMENT_MISMATCH` | `apply` rechazado porque el entorno de la escritura no coincide con el entorno de la vinculación |

`AdapterContractError` lleva `code`, `message` y `details`. El
`code` es el rechazo legible por máquina; `message` es prosa para
humanos; `details` es un `Record<string, unknown>` congelado para
metadatos de diagnóstico (p. ej. `repoPath`, `symlinkCode`,
`bindingId`).

Fuente: `packages/adapter-sdk/src/index.ts:472-505`.

## Arnés de conformidad

El SDK envía un arnés de conformidad independiente y reutilizable
para que los autores de adaptadores e integradores de sistema
puedan verificar, sin ningún conocimiento específico del producto,
que un adaptador:

1. Declara una versión de contrato compatible con el mayor
   congelado del SDK e informa el rango de extensiones provisional
   de forma explícita.
2. No permite que se soliciten escrituras de alias (las rutas de
   alias y los destinos de alias son artefactos derivados, no
   fuentes canónicas).
3. Se niega a activar vinculaciones ambiguas.
4. Falla cerrado ante capacidades no admitidas.
5. Se niega a representar autoridad de aprobación o publicación a
   través de cualquier ruta de servicio o agente.

El arnés es deliberadamente agnóstico al producto. Trabaja sobre
las formas declaradas en `index.ts` y sobre `RegionBinding` desde
`@cms/core`. El constructor de fixtures `makeConformanceFixtures()`
construye una vinculación válida más cuatro vinculaciones ambiguas —
una cuyos destinos de alias colisionan con la ruta de la fuente
canónica dos veces, una con auto-alias, una con alias que escapa
por ruta relativa y una con artefactos derivados vacíos — y tres
identidades: humana, de servicio y de agente con forma MCP.

```ts
import { makeConformanceFixtures, runConformance } from '@cms/adapter-sdk';

const report = await runConformance(adapter, makeConformanceFixtures());
if (!report.ok) {
  // inspeccionar report.checks para la sonda que falló
}
```

`ConformanceCheck` lleva `name`, `ok` y `details`. Los nombres del
arnés incluyen `contract.version`, `discovery`,
`activation.valid`, `activation.ambiguous_refused`, `reconcile`,
`apply.canonical`, `apply.derived_refused`, `apply.alias_refused`,
`apply.service_refused`, `apply.agent_refused`,
`apply.environment_refused` y `capability.fail_closed`.

Fuente: `packages/adapter-sdk/src/conformance.ts:1-160`,
`packages/adapter-sdk/src/conformance.ts:181-305`.

## Anclajes de evidencia del núcleo congelado

- `packages/adapter-sdk/src/index.ts` — contrato congelado de
  `canonical_source` / `derived_artifacts` / `regeneration_contract`;
  `alias_symlink` es el único modo congelado; reconciliar es de
  solo lectura, aplicar es solo canónico; unión cerrada
  `ADAPTER_REFUSAL_CODES`.
- `packages/adapter-sdk/src/conformance.ts` — arnés de rechazo para
  rutas de aplicar de servicio / agente; sondas de solo lectura y
  sondas adversas de aplicar; comprobación de anuncio de
  capacidades del conjunto cerrado.
- `packages/core/src/domain.ts` — `RegionBinding`,
  `CanonicalSource`, `DerivedArtifact`, `RegenerationContract`,
  `assertRegionBinding`.
- `packages/adapter-cerafica/src/index.ts` — primera implementación
  de referencia; véase
  [`docs/adapters/cerafica.md`](../adapters/cerafica.md) ·
  [`.es`](../adapters/cerafica.es.md).
- `packages/adapter-cerafica/src/symlink.ts` — único punto en el
  que un adaptador inspecciona un alias verificado del sistema de
  archivos.

## Restricciones abiertas

El segundo adaptador es la **puerta de conformidad de v1.1**, no
una afirmación de completitud de V1. Los campos de extensión
específicos del host del SDK siguen siendo provisionales hasta que
un segundo adaptador los ejercite; véase
[`docs/overview.es.md`](../overview.es.md) · [English](../overview.md) y
[`docs/evidence/limitations.md`](../evidence/limitations.md). La unión cerrada
documentada arriba es lo que envía V1.