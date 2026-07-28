# Solución de problemas

> [English version](troubleshooting.md) · El inglés y el español son locales pares. Ambos archivos se publican en el mismo pull request (regla de cero desfase). Véase [`README.es.md#desfase-cero-enes-en-el-mismo-pr`](README.es.md#desfase-cero-enes-en-el-mismo-pr).

Esta página está dirigida a las audiencias de **operador** y **autoalojador**. Asigna los síntomas que se pueden observar al estado del ciclo de vida en el que se encuentra la propuesta, enumera los códigos canónicos de problema para fallos de OIDC, configuración, medios y adaptador, y apunta a las notas de reconciliación y reversión que cierran el ciclo. Nada de esta página afirma un daemon Docker en vivo: el informe de verificación de V1 en `artifacts/g008/workspace-test-report.json` muestra que solo se ejecutó `docker compose -f compose.yaml config --quiet`, y la imagen no se compiló.

## Límite de audiencia

Handoff CMS tiene tres roles operativos. Esta página aborda al **operador de agencia** que ejecuta un stack de compose administrado y al **autoalojador** que ejecuta el stack completo en un host propio. Las audiencias adyacentes viven en sus propias páginas:

- El **autor** que edita contenido a través de la superficie autenticada por OIDC está cubierto por [`docs/how-to/authoring.md`](how-to/authoring.md) · [`.es`](how-to/authoring.es.md). El autor nunca ve códigos de salida; el autor ve estados de la UI y `STORE_ERROR_CODES` estables.
- La **persona integradora** que escribe un adaptador está cubierta por [`docs/reference/adapter-sdk.es.md`](reference/adapter-sdk.es.md) · [English](reference/adapter-sdk.md).
- La **persona revisora de seguridad** está cubierta por [`docs/security/reviewer-on-ramp.es.md`](security/reviewer-on-ramp.es.md) · [English](security/reviewer-on-ramp.md), con el modelo de amenazas y las guías de endurecimiento enlazados allí.

Los estados del ciclo de vida, el momento de escritura canónica y el estado terminal `rolled_back` se documentan por separado en [`docs/concepts/governance-and-human-authority.md`](concepts/governance-and-human-authority.md) · [`.es`](concepts/governance-and-human-authority.es.md) y en [`docs/concepts/content-boundary.md`](concepts/content-boundary.md) · [`.es`](concepts/content-boundary.es.md). Los códigos de salida de la CLI y de la API se documentan en [`docs/reference/cli.md`](reference/cli.md) · [`.es`](reference/cli.es.md). Las uniones cerradas de códigos de error se documentan en [`docs/reference/error-codes.md`](reference/error-codes.md) · [`.es`](reference/error-codes.es.md). Esta página es intencionalmente la entrada de navegación que asigna **síntoma → estado del ciclo de vida → código → remediación**.

## Cómo leer esta página

Las seis secciones siguientes responden seis preguntas:

1. **Síntomas a estados del ciclo de vida.** Lo que la UI, la CLI y la API muestran cuando la propuesta está en un estado determinado.
2. **Fallos de OIDC y configuración.** Lo que dicen las uniones cerradas `SERVER_CONFIG_ERROR_CODES` y `API_ERROR_CODES`, y dónde se originan en el runtime.
3. **Fallos de medios y adaptador.** Lo que dicen las `STORE_ERROR_CODES` cerradas y las comprobaciones del adaptador, y cómo diferenciar entre un problema de subida de medios y un problema de contrato del adaptador.
4. **Navegación de problema → código de salida de la CLI.** Qué código de problema se asigna a qué código de salida de la CLI, para que un script pueda ramificar en el código de salida sin analizar el cuerpo JSON.
5. **Notas de reconciliación.** Las notas de reconciliación, incluido el borde `canonical_written + propagate → propagate_failed` ausente y la limitación diferida del esquema de propietario de publicación.
6. **Limitaciones.** Lo que no está verificado.

Cada una se fundamenta en el archivo fuente que ancla el contrato.

## 1. Síntomas a estados del ciclo de vida

La máquina de estados de propuestas (`packages/core/src/state-machine.ts`) tiene exactamente dieciocho estados, once acciones y un estado terminal (`rolled_back`). La asignación desde los estados de contabilidad que se pueden observar (`canonical_written`, `canonical_write` devuelto por el endpoint de publish, recibos de despliegue reportados asíncronamente) al estado de la propuesta está a continuación.

### `canonical_written` y el momento de publish

El endpoint de publish devuelve `canonical_written` después de que los bytes canónicos se han escrito en el host. Esto **no** es una afirmación de que un sitio remoto esté en vivo. El ciclo de vida es:

- `approved → applying → canonical_written` (transición de publish).
- `canonical_written → propagating → live` (camino de recibo de despliegue) **o** `canonical_written → write_failed` (una segunda escritura canónica falló; la propuesta es recuperable).
- Un recibo de despliegue fallido deja la propuesta en `canonical_written`; el sistema no inventa silenciosamente un estado intermedio. La fila de recibo es el registro autoritativo de fallo.

Si la UI muestra `canonical_written` durante más tiempo del esperado, el despliegue está en curso o ha fallado. Lea la tabla de recibos — `GET /v1/publications/{id}/deploy-receipts` o la superficie CLI equivalente — y actúe sobre el estado del recibo.

### `rolled_back` y el estado terminal de reversión

El endpoint de rollback es una única acción compensatoria autorizada por una persona. No reproduce credenciales ni suplanta a quien aprobó originalmente, y no emite un recibo "live" sintético. El límite de escritura del adaptador gobernado termina en `canonical_written`; el ciclo de vida de la propuesta transita al estado terminal `rolled_back` y se audita como `proposal.rolled_back`. La reconciliación asíncrona del despliegue sigue la escritura canónica e informa por separado si el sitio servido se pone al día.

`rolled_back` es el único estado terminal. `isTerminalState` (`packages/core/src/state-machine.ts:204-206`) devuelve `true` exclusivamente para `rolled_back`. Tras la reversión, la propuesta es definitiva; los intentos posteriores de actuar sobre ella devuelven `E_INVALID_TRANSITION`.

### `propagate_failed` y la transición ausente

La máquina de estados **no** tiene un borde directo `canonical_written + propagate → propagate_failed`. No hay ninguna transición de `canonical_written` a `propagate_failed` en la tabla `TRANSITIONS` (`packages/core/src/state-machine.ts:100-128`). Un recibo de despliegue fallido registrado contra una propuesta en `canonical_written` no mueve la propuesta a `propagate_failed`; la propuesta permanece en `canonical_written`, y la fila de recibo de despliegue lleva la razón del fallo. Esta es la redacción canónica del resumen de OpenAPI para `POST /v1/publications/{id}/deploy-receipts`.

Cuando vea un recibo de despliegue `failed` y la propuesta sigue en `canonical_written`, la remediación es una de:

1. **Volver a ejecutar el despliegue.** Dispare un nuevo despliegue desde la fila de publicación; la propuesta permanece en `canonical_written` hasta que llegue un recibo terminal.
2. **Reversión.** Emita una reversión gobernada desde la propuesta; la propuesta transita al estado terminal `rolled_back` y los bytes canónicos se revierten a la instantánea de aprobación capturada.
3. **Reconciliación.** Emita una reconciliación contra la propuesta; la propuesta transita a `reconciled` (o `reconcile_failed`). La reconciliación es de solo lectura; no escribe bytes.

La máquina de estados es la autoridad para qué transición es legal; el servicio de aplicación que rodea a `transition()` valida la versión, el actor y la ventana antes de la transición pura.

### `reconcile_failed` y el alfabeto de almacenamiento

El estado de núcleo `reconcile_failed` se asigna al estado de propuesta de almacenamiento `reconcile_pending` (`packages/core/src/state-machine.ts:254-273`). La restricción CHECK de la capa de almacenamiento en `proposals.state` (`packages/storage/src/schema.ts:322`) acepta el alfabeto de almacenamiento (que incluye `reconcile_pending`) y los estados de núcleo que se asignan a él; la fila `reconcile_pending` es el registro persistido de que la propuesta espera una decisión gobernada de recuperación. El sobre de auditoría lleva el estado de núcleo original a través del payload `event`, por lo que la proyección es recuperable.

Si su consulta espera ver `reconcile_failed` en la fila de almacenamiento, la fila mostrará `reconcile_pending` en su lugar. La asignación es exacta y total; la fila de auditoría es la ruta de recuperación.

### `rolled_back` frente a `canonical_written`

Los dos **no** son el mismo momento. `canonical_written` es el momento de escritura canónica: la propuesta se ha escrito en el `canonical_source` del host (`inventory/products.json` para el adaptador de referencia de Cerafica), y la fila de publicación registra `canonical_written_at`. `rolled_back` es el estado terminal al que entra la propuesta tras una única acción compensatoria autorizada por una persona; los bytes canónicos se revierten a la instantánea de aprobación capturada, y el ciclo de vida de la propuesta se cierra.

El adaptador de Cerafica lo refleja exactamente: la reversión escribe los bytes canónicos y devuelve `canonical_written` (la capacidad de despliegue del adaptador devuelve `canonical_written` después de la escritura de reversión; el ciclo de vida de la propuesta registra por separado `rolled_back`). Una reconciliación asíncrona sigue la escritura canónica y no reclama `live`. Véase `packages/adapter-cerafica/src/index.ts:1213-1238` y `packages/adapter-cerafica/src/index.ts:860-871`.

### Estados de insignia frente a estados literales

La superficie de autoría web renderiza un conjunto cerrado de estados de insignia (`VisibleState` en `packages/web/src/model.ts:151-160`). La asignación es intencional y acotada:

| Insignia | Estado de núcleo | Notas |
| --- | --- | --- |
| `editing` | (draft, antes de cualquier transición) | No forma parte del ciclo de vida persistido. |
| `preview_ready` | `previewing` (transitorio) | La vista previa renderizada por el servidor se generó con éxito. |
| `proposed` | `proposed` | La propuesta se ha enviado. |
| `approved` | `approved` | La propuesta se ha aprobado. |
| `canonical_written` | `canonical_written` | El momento de escritura canónica. |
| `deploy_pending` | `canonical_written` (comodín de UI) | Aún no hay recibo terminal. |
| `live` | `live` | Un recibo `succeeded` terminal. |
| `rolled_back` | `rolled_back` | Terminal. |
| `error` | cualquier rama de fallo | La superficie de error recuperable de la UI. |

Si la insignia de la UI no coincide con el estado de la API, el estado de la API es la autoridad. La insignia es una proyección en tiempo de render; el estado de la API es el cursor persistido.

## 2. Fallos de OIDC y configuración

### `SERVER_CONFIG_ERROR_CODES` (arranque del servidor)

El servidor es fail-closed al arrancar. El cargador en `packages/server/src/config.ts` lanza un `ServerConfigError` con un código estable de la unión cerrada:

```ts
export const SERVER_CONFIG_ERROR_CODES = [
  'E_CONFIG_MISSING_REQUIRED',
  'E_CONFIG_INVALID_TYPE',
  'E_CONFIG_OUT_OF_RANGE',
  'E_CONFIG_INVALID_URL',
  'E_CONFIG_INVALID_LOG_LEVEL',
] as const;
```

Los códigos están anclados en `packages/server/src/config.ts:22-30`. El error lanzado lleva una bolsa `details` con el nombre de la variable ofensor; nunca incorpora valores de secreto. La primera verificación más simple es leer la bolsa `details` y compararla con el inventario de `.env.example` en la raíz del repositorio.

Remediación común:

- `E_CONFIG_MISSING_REQUIRED` — un valor `CMS_*` requerido está sin definir. Compose lo detectaría antes con la forma de sustitución `${VAR:?message}` para cada secreto (`compose.yaml:75`, `compose.yaml:115`, `compose.yaml:154-155`); el código solo aparece cuando el servidor arranca en un contexto que no es compose (por ejemplo, `node packages/server/dist/index.js`).
- `E_CONFIG_INVALID_URL` — `CMS_PUBLIC_URL`, `CMS_OIDC_ISSUER`, `CMS_OIDC_AUDIENCE`, `CMS_OIDC_JWKS_URL` o `CMS_OBJECT_ENDPOINT` tienen un formato inválido.
- `E_CONFIG_OUT_OF_RANGE` — un entero de cuota (`CMS_QUOTA_REQUEST_BYTES_CAP`, `CMS_QUOTA_TENANT_REQUESTS_PER_MINUTE`) está fuera de rango.
- `E_CONFIG_INVALID_LOG_LEVEL` — `CMS_LOG_LEVEL` no está en el conjunto permitido.
- `E_CONFIG_INVALID_TYPE` — un valor analizado no coincide con el tipo esperado (por ejemplo, un no entero donde se requiere un entero).

### Fallos de OIDC (tiempo de solicitud)

La lista configurada de algoritmos solo contiene variantes asimétricas RS, ES y PS; `none` y `HS*` se rechazan mediante `ALLOWED_ALGORITHMS` y `parseAlgorithms` ([`packages/server/src/config.ts:246-284`](../packages/server/src/config.ts#L246-L284)). Los `API_ERROR_CODES` cerrados reflejan la superficie de fallo de OIDC en [`packages/api/src/problem.ts:35-56`](../packages/api/src/problem.ts#L35-L56):

| Código | Fallo | Remediación |
| --- | --- | --- |
| `E_TOKEN_MISSING` | No hay encabezado `Authorization`. | Añada el token bearer. |
| `E_TOKEN_MALFORMED` | El token no es un JWT analizable o faltan los claims requeridos. | Verifique el emisor OIDC y la audiencia. |
| `E_TOKEN_EXPIRED` | `exp` está en el pasado. | Obtenga un token nuevo. |
| `E_TOKEN_AUDIENCE_MISMATCH` | `aud` no coincide con `CMS_OIDC_AUDIENCE`. | Verifique la audiencia en la configuración del cliente OIDC. |
| `E_UNAUTHORIZED` | Respaldo genérico de no autorizado. | Revise el registro del verificador para la razón subyacente. |

La CLI asigna `E_TOKEN_EXPIRED` a la salida 77; `E_TOKEN_MISSING`, `E_TOKEN_MALFORMED`, `E_TOKEN_AUDIENCE_MISMATCH` y `E_UNAUTHORIZED` usan la asignación genérica de códigos `E_*` a la salida 2 ([`packages/cli/src/index.ts:1071-1103`](../packages/cli/src/index.ts#L1071-L1103)). El mismo código de problema permanece en el JSON de stderr.

### Autoaprobación e identidades de servicio / MCP rechazadas

Las tres acciones privilegiadas (`approve`, `publish`, `rollback`) se rechazan para identidades de servicio y para identidades que llevan la capacidad `mcp` antes de que el motor de políticas se ejecute (`packages/api/src/auth.ts:197-225`). Los códigos se exportan desde la unión de errores de núcleo (`packages/core/src/domain.ts:86-114`):

- `E_SERVICE_APPROVAL_FORBIDDEN` — una identidad de servicio intentó una aprobación / publicación / reversión. La CLI lo asigna al código de salida 77.
- `E_MCP_APPROVAL_FORBIDDEN` — una identidad de MCP intentó lo mismo. Código de salida 77 de la CLI.
- `E_SELF_APPROVAL_FORBIDDEN` — la autoaprobación se registra explícitamente (`selfApproved: true`) pero se rechaza cuando la política no la permite. Código de salida 77 de la CLI.

La puerta de comandos privilegiados de la CLI ([`packages/cli/src/index.ts:773-801`](../packages/cli/src/index.ts#L773-L801)) exige una sesión `delegated_human_fresh_interactive` para aprobar, publicar, revertir y reconciliar el despliegue. Las credenciales estáticas `env_token`, `cli_service` y `mcp_identity` fallan de forma cerrada.

### Rechazos del ciclo de vida

La máquina de estados rechaza las transiciones ilegales con `E_INVALID_TRANSITION` (`packages/core/src/domain.ts:108`). La CLI lo asigna al código de salida 2. El error lanzado lleva el estado `from` ofensor y la `action` intentada. La remediación siempre es dependiente del estado: vuelva a ejecutar el comando contra el estado actual de la propuesta, o espere a que la acción en curso se complete.

## 3. Fallos de medios y adaptador

### `STORE_ERROR_CODES` (superficie de autoría web)

La superficie de autoría web reporta un conjunto cerrado de códigos de error de UI (`packages/web/src/model.ts:111-133`):

| Código | Cuándo | Remediación |
| --- | --- | --- |
| `E_BAD_BLOCK_ID` | El id de bloque no está en la instantánea. | Refresque la página; la instantánea está obsoleta. |
| `E_BAD_LOCALE` | La locale no es `en` ni `es`. | Cambie el selector de idioma a una locale par. |
| `E_BAD_INDEX` | El índice destino de mover, duplicar o insertar un bloque está fuera de los límites de la instantánea. | Refresque y repita la acción con un índice válido para la instantánea actual. |
| `E_MISSING_ALT` / `E_EMPTY_ALT` / `E_MISSING_ALT_LOCALE` | Falta o está vacío el texto alternativo de imagen en una locale par. | Rellene el texto alternativo en ambas locales. |
| `E_BAD_CROP` / `E_BAD_FOCAL` | Los valores de recorte o punto focal están fuera del rango válido. | Restablezca el recorte; el modelo acepta un desplazamiento del punto focal relativo al recorte. |
| `E_BAD_BYTES` | Los bytes subidos fallaron la comprobación de integridad de la tubería de medios. | Vuelva a subir el archivo; la cuarentena ha registrado el fallo. |
| `E_SERVICE_APPROVAL_FORBIDDEN` / `E_MCP_APPROVAL_FORBIDDEN` | Identidad de servicio / MCP intentó una acción privilegiada en la aplicación. | Cambie a una sesión OIDC humana. |
| `E_NO_PROPOSAL` | La propuesta no se creó antes de la acción privilegiada. | Cree la propuesta primero. |
| `E_NOT_PREVIEW_READY` | La acción privilegiada se intentó antes de que la vista previa se completara. | Ejecute la vista previa; la acción requiere un estado `preview_ready`. |
| `E_NOT_APPROVED` | Se intentó publicar una propuesta no aprobada. | Apruebe la propuesta primero. |
| `E_NOT_LIVE` | Se intentó revertir una propuesta no en vivo. | La reversión se permite desde `live` y `error`; verifique el estado visible. |
| `E_NOT_DEPLOY_READY` | Se intentó reconciliar una propuesta sin despliegue en curso. | La reconciliación es de solo lectura; vuelva a ejecutarla solo cuando haya un despliegue pendiente. |
| `E_NOT_REVERSIBLE` | Se excedió la profundidad de deshacer local. | El deshacer local es del navegador; pida al operador una reversión gobernada. |
| `E_RECONCILE_FORBIDDEN` | Se intentó reconciliar desde un estado que no lo permite. | El modelo permite la reconciliación desde `canonical_written`, `deploy_pending` y `live`; verifique el estado. |
| `E_FROZEN_BLOCK` | Se intentó la acción de bloque sobre un bloque congelado. | Use las acciones de bloque expuestas para la sección. |
| `E_INVALID_SNAPSHOT` | La instantánea es inconsistente. | Refresque; el modelo recrea la instantánea desde la API. |
| `E_API_ERROR` | La API devolvió una respuesta no-2xx. | Lea el código de problema de la API; el modelo lo expone. |

### Fallos de la tubería de medios

La tubería de medios en `packages/media/src/` es un `BlobStore` enchufable sobre el almacén de objetos compatible con S3. El ICC se preserva, el EXIF se elimina y la cuarentena de malware es fail-closed. Los modos de fallo más comunes desde la perspectiva del operador son:

- **Subida rechazada por el navegador.** La tubería valida el flujo de bytes antes de que se suban las partes. El modelo expone el rechazo como `E_BAD_BYTES`; el navegador muestra el error de bytes en la región de error.
- **Subida aceptada pero la cuarentena falló.** La tubería acepta los bytes para cribado, pero el cribado los rechaza. El modelo registra el fallo; la instantánea no cambia. La remediación es volver a subir un archivo no en cuarentena; la cuarentena es auditable por el operador.
- **Almacén de objetos inalcanzable.** El servicio MinIO no está saludable. El modelo expone el error de la API; la remediación es restaurar la salud del servicio `minio` (véase el [healthcheck del servicio minio](https://min.io/docs/minio/linux/operations/monitoring/healthcheck-probes.html) para la sonda oficial). El healthcheck preestablecido por la aplicación es `mc ready local` después de `mc alias` (`compose.yaml:160-166`).
- **La política del bucket se desvió.** El one-shot `minio-init` crea el bucket y el usuario de aplicación con alcance de bucket. Si el operador edita la política del bucket fuera del flujo `minio-init`, el usuario de la aplicación puede perder un permiso que necesita (por ejemplo, `s3:PutObject` en su bucket). La remediación es volver a ejecutar `minio-init`; la política se reaplica de forma idempotente.

### Fallos del adaptador

El contrato del adaptador es el triple congelado invariante `canonical_source` / `derived_artifacts[]` / `regeneration_contract`. El `binding.discover` del SDK del adaptador devuelve un informe `discovery` (`packages/adapter-sdk/src/index.ts`); el arnés de conformidad lo ejercita (`packages/adapter-sdk/src/conformance.ts`). Los modos de fallo más comunes desde la perspectiva del operador son:

- **E_BAD_REGENERATION_MODE.** El `regeneration_contract.mode` de la vinculación no está en la lista permitida congelada (`alias_symlink` es el único modo congelado en V1). La comprobación se activa en la activación; la vinculación se rechaza.
- **E_EMPTY_DERIVED_ARTIFACTS.** La lista `derived_artifacts[]` está vacía. La comprobación se activa en la activación; la vinculación se rechaza.
- **E_AMBIGUOUS_BINDING.** El adaptador no puede resolver una única fuente canónica. La comprobación se activa en la activación; la vinculación se rechaza.
- **E_ABSOLUTE_PATH / E_ESCAPING_PATH / E_SELF_ALIAS / E_CYCLIC_ALIAS.** Comprobaciones de confinamiento del repositorio en la activación. La vinculación se rechaza.
- **E_DERIVED_WRITE_FORBIDDEN.** Un intento de escritura cuyo destino es un artefacto derivado. El adaptador lo rechaza; la API expone el rechazo.

La **limitación diferida del esquema de propietario de publicación** está en el endpoint de **reconciliación**. La ruta en `packages/api/src/index.ts:637-682` requiere una autoridad humana actual. Una vinculación de propietario de publicación más estricta es un bloqueador de integración explícito: el esquema de almacenamiento debe crecer una columna `publication_owner_actor_id` y un hook `IdentityResolver.loadPublicationOwner` correspondiente antes de que se pueda hacer cumplir la propiedad por publicación. El hook es el mismo que se usa para la comprobación de propiedad por publicación en `approve` / `publish` / `rollback`. El bloqueador está registrado en `artifacts/g009/inventory-findings.json` hallazgo `API-DEPLOY-AUTHORITY-BINDING`. Por lo tanto, la ruta de reconciliación acepta **cualquier** identidad humana actual hasta que aterrice la migración de almacenamiento; la ruta no es una autoridad de escritura por publicación.

## 4. Navegación de problema → código de salida de la CLI

La CLI asigna códigos de problema a códigos de salida (`packages/cli/src/index.ts:1071-1100`). La asignación es cerrada y de valor entero; un script puede ramificar en el código de salida sin analizar el cuerpo JSON.

| Código de salida | Significado | Códigos de problema |
| --- | --- | --- |
| `1` | Error inesperado | Códigos de problema no reconocidos que no comienzan con `E_*` y no tienen una asignación específica. |
| `2` | No encontrado / problema genérico | `not_found`, códigos `E_*` sin una asignación específica. |
| `3` | Fallo de red | `connection_failed`, o cadenas de mensaje fetch / network / ENOTFOUND / ECONN. |
| `4` | Conflicto | `E_OPTIMISTIC_CONCURRENCY_CONFLICT`, `optimistic_concurrency_conflict`, `idempotency_replay_mismatch`, `idempotency_in_progress`. |
| `64` | Error de uso | Análisis local de argumentos de la CLI. |
| `65` | Error de validación | `E_BAD_REQUEST`, `invalid_input`. |
| `77` | Fallo de autorización | `E_SERVICE_APPROVAL_FORBIDDEN`, `E_MCP_APPROVAL_FORBIDDEN`, `E_TOKEN_KIND_FORBIDDEN`, `E_INTERACTIVE_AUTH_REQUIRED`, `E_TENANT_MISMATCH`, `E_TOKEN_EXPIRED`, `E_INVALID_IDENTITY`, `E_TENANT_FORBIDDEN`, `E_INSUFFICIENT_AUTHORITY`, `E_ACTION_FORBIDDEN`, `E_SELF_APPROVAL_FORBIDDEN`. |

El `cliErrorToExitCode` de la CLI para las categorías de error locales (`packages/cli/src/index.ts:1137-1157`) tiene la misma forma: `usage` → 64, `credential_forbidden` → 77, `network` → 3, `problem` → 2, `conflict` → 4, `not_found` → 2, `validation` → 65, `unexpected` → 1.

La CLI conserva la forma de cable del problema de la API (`packages/cli/src/index.ts:1020-1038`). Un script que quiera registrar el `code` y el `traceId` puede leer el JSON de problema de stderr en lugar de ramificar en el código de salida.

## 5. Notas de reconciliación

La acción de reconciliación es una verificación de **solo lectura**. Vuelve a ejecutar la verificación del alias y la comprobación del hash canónico; no escribe. `apply` es solo canónica y se niega a ejecutarse antes de que la reconciliación haya observado el último estado canónico (`packages/adapter-sdk/src/index.ts:33-44`). El adaptador de Cerafica lo aplica encima: `apply` escribe el `inventory/products.json` canónico; la reconciliación vuelve a verificar el alias y el hash e informa estado, nunca bytes (`packages/adapter-cerafica/src/index.ts:11-24`).

Tres notas relacionadas con la reconciliación merecen repetirse:

- **La reconciliación no escribe bytes.** Registra una reconciliación exitosa o un fallo de reconciliación explícito. La propuesta avanza a `reconciled` (éxito) o a `reconcile_failed` (fallo). Una reconvergencia que falla deja la propuesta en `reconcile_failed`; la fila de auditoría registra la razón.
- **La limitación diferida del esquema de propietario de publicación.** El endpoint de reconciliación requiere una identidad humana actual. La propiedad por publicación es un bloqueador de integración explícito: el esquema de almacenamiento debe crecer una columna `publication_owner_actor_id` y un hook `IdentityResolver.loadPublicationOwner` correspondiente antes de que se pueda hacer cumplir la propiedad por publicación. Hasta que aterrice la migración, la ruta acepta cualquier identidad humana actual. El bloqueador está en `artifacts/g009/inventory-findings.json` hallazgo `API-DEPLOY-AUTHORITY-BINDING` y también se refleja en el resumen de OpenAPI para `reconcileProposal`.
- **El borde `canonical_written + propagate → propagate_failed` está ausente intencionalmente.** No hay una transición directa de `canonical_written` a `propagate_failed` en la máquina de estados (`packages/core/src/state-machine.ts:100-128`). Un recibo de despliegue fallido deja la propuesta en `canonical_written`; la fila de recibo de despliegue es el registro autoritativo de fallo. La propuesta no recorre silenciosamente un estado intermedio `propagating` que nunca visitó.

## 6. Limitaciones

- **Sin compilación ni ejecución respaldada por un daemon Docker.** La configuración de Compose se valida solo por interpolación; la imagen del contenedor no se compiló y el servidor no se ejecutó dentro de Docker. Los códigos y los estados del ciclo de vida anteriores son el comportamiento de la aplicación; ejecutarlos contra un contenedor en vivo es administrado por el operador.
- **Sin un segundo adaptador.** El adaptador de referencia de Cerafica es el único adaptador en V1. Los modos de fallo del adaptador son los fallos específicos de Cerafica; un segundo adaptador que introduzca un nuevo backend `canonical_source` es la puerta de validación de contrato de v1.1.
- **Validación externa con participantes es v1.1.** El producto se describe en el catálogo de i18n como "neurodivergent-accessible by design"; la validación externa no está en V1.

## Dónde continuar

- Páginas de conceptos: [`docs/concepts/governance-and-human-authority.md`](concepts/governance-and-human-authority.md) · [`.es`](concepts/governance-and-human-authority.es.md), [`docs/concepts/content-boundary.md`](concepts/content-boundary.md) · [`.es`](concepts/content-boundary.es.md).
- Guía de autoría: [`docs/how-to/authoring.md`](how-to/authoring.md) · [`.es`](how-to/authoring.es.md).
- Autoalojamiento y configuración: [`docs/how-to/self-host.md`](how-to/self-host.md) · [`.es`](how-to/self-host.es.md), [`docs/how-to/configure.md`](how-to/configure.md) · [`.es`](how-to/configure.es.md).
- Copia de seguridad y restauración: [`docs/how-to/backup-restore.md`](how-to/backup-restore.md) · [`.es`](how-to/backup-restore.es.md).
- Referencia: [`docs/reference/api.md`](reference/api.md) · [`.es`](reference/api.es.md), [`docs/reference/cli.md`](reference/cli.md) · [`.es`](reference/cli.es.md), [`docs/reference/error-codes.md`](reference/error-codes.md) · [`.es`](reference/error-codes.es.md).
- Glosario: [`docs/project/glossary.md`](project/glossary.md) · [`.es`](project/glossary.es.md).
- Informe de verificación: `artifacts/g008/workspace-test-report.json`.
