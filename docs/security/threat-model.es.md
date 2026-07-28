# Modelo de amenaza

> **Audiencia:** revisores de seguridad. Esta página es el modelo de amenaza cerrado de V1 para Handoff CMS. Mapea cada amenaza a una unión cerrada de códigos de rechazo, una página par o una ubicación exacta en el código fuente que el sistema usa para detectar o contener la amenaza. Las citas primarias de OWASP aparecen en línea (consultada el 2026-07-28). La contraparte operativa está en [`hardening.es.md`](hardening.es.md) (EN: [`hardening.md`](hardening.md)); el índice de revisión está en [`reviewer-on-ramp.es.md`](reviewer-on-ramp.es.md) (EN: [`reviewer-on-ramp.md`](reviewer-on-ramp.md)).

> [English version](threat-model.md) · Las versiones inglesa y española son pares. Ambas se envían en el mismo *pull request*. Véase [`../README.es.md#desfase-cero-enes-en-el-mismo-pr`](../README.es.md#desfase-cero-enes-en-el-mismo-pr).

## Qué cubre este modelo

Handoff CMS es una proyección autoalojada y gobernada de entrega de contenido entre una superficie de autoría autenticada por OIDC y un repositorio anfitrión que sigue siendo canónico. El sistema no se convierte en fuente de verdad; los únicos bytes que escribe son escrituras canónicas autorizadas por una decisión humana vigente sobre el `canonical_source` del host, además del registro de auditoría.

Esta página enumera las amenazas, la respuesta cerrada ya en el código y la obligación operativa residual. Cada entrada lleva una etiqueta `STRIDE` y se asocia al menos a uno de: una unión de códigos de rechazo, una lista cerrada de capacidades, una página par o una ubicación exacta del código fuente. La página no introduce comportamientos, garantías ni superficies nuevas; documenta lo que ya se aplica.

Fuera del alcance: amenazas del lado del host, la prueba de identidad del emisor OIDC y ataques de accesibilidad del navegador (véase [`../accessibility/statement.es.md`](../accessibility/statement.es.md) (EN: [`../accessibility/statement.md`](../accessibility/statement.md))).

## Zonas de confianza

| Zona | Supuesto de confianza | Propietaria en el código |
| --- | --- | --- |
| Estación operadora | Entrega de `.env` y secretos Docker. | Operadora |
| Red del servidor | `cms_data` (interna) y `cms_egress` (única con egreso). | `compose.yaml` |
| Cliente de autoría | Navegador alcanzado mediante *bearer* OIDC. | `@cms/web`, `@cms/api` |
| Clientes MCP / de servicio | Cortafuegos de nombre y argumentos; sin aprobar / publicar / aplicar. | `@cms/mcp`, `@cms/server` |
| Repositorio anfitrión | Alias de sistema de archivos y vinculación canónica; la reconciliación es de sólo lectura. | Adaptador + host |

El emisor OIDC es confiable para afirmar `iss`, `aud`, `exp`, `nbf`, `tenantId`, `actorId`, `kind`, `scope`. Todo lo que esté por debajo de ese umbral se valida en el servidor contra la unión cerrada `SERVER_AUTH_ERROR_CODES` ([`packages/server/src/auth.ts`](../../packages/server/src/auth.ts) · [`../reference/error-codes.es.md`](../reference/error-codes.es.md) (EN: [`../reference/error-codes.md`](../reference/error-codes.md))).

## Uniones cerradas de códigos de rechazo

| Unión | Paquete | Citada en |
| --- | --- | --- |
| `SERVER_AUTH_ERROR_CODES` | `@cms/server` | §1, §2, §3 |
| `API_ERROR_CODES` | `@cms/api` | §2, §4 |
| `ADAPTER_REFUSAL_CODES` | `@cms/adapter-sdk` | §5, §6 |
| `SYMLINK_REFUSAL_CODES` | `@cms/adapter-cerafica` | §5, §6 |
| `MEDIA_PIPELINE_ERROR_CODES` | `@cms/media` | §7 |
| `BLOB_STORE_ERROR_CODES` | `@cms/media` | §5, §7 |
| `SERVER_CONFIG_ERROR_CODES` | `@cms/server` | §9 |
| `ERROR_CODES` (Core) | `@cms/core` | §5, §6, §8 |

La composición es cerrada; un literal que no esté en la tupla de tiempo de ejecución no es un rechazo que el sistema pueda producir.

## 1. Identidad

*STRIDE: Suplantación / Escalada.* Una identidad no humana intenta autenticarse como persona autora o aprobadora.

Qué hace el sistema. La reclamación `kind` se analiza contra `'human' | 'service'` ([`packages/server/src/auth.ts`](../../packages/server/src/auth.ts)); cualquier otro valor lanza `E_TOKEN_MALFORMED` con `extensions` redactado. La fachada de autoridad rechaza identidades de servicio y MCP en `approve`, `publish` y `rollback` con `E_SERVICE_APPROVAL_FORBIDDEN` y `E_MCP_APPROVAL_FORBIDDEN` ([`packages/api/src/auth.ts`](../../packages/api/src/auth.ts) · [`../concepts/governance-and-human-authority.es.md`](../concepts/governance-and-human-authority.es.md) (EN: [`../concepts/governance-and-human-authority.md`](../concepts/governance-and-human-authority.md))).

Obligación residual. La prueba de identidad OIDC es contrato del emisor; el sistema consume `kind`. Cita: OWASP ASVS V2; OWASP Top 10 A07:2021.

## 2. Token

*STRIDE: Suplantación / Repetición / Manipulación.* Un *bearer* falsificado, repetido o sustituido.

Qué hace el sistema. Verificador exclusivamente asimétrico (`none` y `HS*` se rechazan). Se comprueban `iss`, `aud`, `exp`, `nbf` con sesgo de reloj acotado, caché de JWKS acotado y *timeout* de descarga acotado ([`packages/server/src/auth.ts`](../../packages/server/src/auth.ts) · [`packages/server/src/config.ts`](../../packages/server/src/config.ts)). Los fallos se mapean a `E_TOKEN_BAD_SIGNATURE`, `E_TOKEN_BAD_AUDIENCE`, `E_TOKEN_BAD_ISSUER`, `E_TOKEN_EXPIRED`, `E_TOKEN_NOT_YET_VALID`, `E_TOKEN_BAD_ALGORITHM` o `E_OIDC_JWKS_UNAVAILABLE`. El verificador nunca registra el *bearer*.

Obligación residual. Disponibilidad de JWKS, rotación de claves e higiene de nomenclatura son incumbencias de la operadora; 30 s de sesgo de reloj es la tolerancia de diseño. Cita: OWASP ASVS V3; RFC 8725.

## 3. Audiencia

*STRIDE: Divulgación de información.* Un *token* para la audiencia A se presenta contra la audiencia B.

Qué hace el sistema. `aud` e `iss` se comprueban antes de cualquier decisión de autoridad ([`packages/server/src/auth.ts`](../../packages/server/src/auth.ts)); el `aud` se acepta como cadena o *array* simétricamente. Los fallos lanzan `E_TOKEN_BAD_AUDIENCE` o `E_TOKEN_BAD_ISSUER`.

Obligación residual. Una audiencia por despliegue; no compartir `CMS_OIDC_AUDIENCE` entre *tenants*. Cita: OWASP ASVS V2.5; RFC 8725 §3.11.

## 4. Vinculación de *tenant*

*STRIDE: Suplantación / Escalada.* Un encabezado `X-Tenant-Id` no coincide con el *token* verificado.

Qué hace el sistema. Cada solicitud protegida a `@cms/api` exige `X-Tenant-Id === token.tenantId` ([`packages/api/src/index.ts`](../../packages/api/src/index.ts)). Los encabezados ausentes o no coincidentes lanzan `E_TENANT_HEADER_REQUIRED` o `E_TENANT_FORBIDDEN`. Cada escritura exige `Idempotency-Key`; aprobar, publicar, revertir y reconciliar exigen además `If-Match`.

Obligación residual. La procedencia de la clave de *tenant* es contrato de la operadora. Cita: OWASP Top 10 A01:2021.

## 5. Confinamiento de ruta y alias

*STRIDE: Manipulación / Repudio.* Atravesamiento de ruta, escape por enlace simbólico, escritura al alias servido, escritura a derivado, bucle de alias o confusión canónico / alias.

Qué hace el sistema. `LocalBlobStore` resuelve cada clave con contención basada en `realpath` y rechaza `..` y escapes por enlace simbólico con `E_TRAVERSAL` y `E_SYMLINK_ESCAPE` ([`packages/media/src/blob-store.ts`](../../packages/media/src/blob-store.ts)). El acceso entre *tenants* lanza `E_CROSS_TENANT`; las escrituras en `video/` lanzan `E_VIDEO_WRITE_FORBIDDEN`. El SDK del adaptador rechaza cualquier `apply` a un derivado (`E_DERIVED_WRITE_FORBIDDEN`) o al alias (`E_ALIAS_WRITE_FORBIDDEN`); las vinculaciones ambiguas o cíclicas lanzan `E_AMBIGUOUS_BINDING` ([`packages/adapter-sdk/src/index.ts`](../../packages/adapter-sdk/src/index.ts) · [`packages/adapter-sdk/src/conformance.ts`](../../packages/adapter-sdk/src/conformance.ts)). La superficie de alias de Cerafica rechaza rutas perdidas, rotas, redestinadas, con escape, con bucle o reemplazadas ([`packages/adapter-cerafica/src/symlink.ts`](../../packages/adapter-cerafica/src/symlink.ts)). Los errores de ruta del dominio central lanzan `E_BAD_PATH`, `E_ABSOLUTE_PATH`, `E_ESCAPING_PATH`, `E_SELF_ALIAS`, `E_CYCLIC_ALIAS`, `E_AMBIGUOUS_CANONICAL`, `E_BAD_REGENERATION_MODE` y `E_EMPTY_DERIVED_ARTIFACTS` ([`packages/core/src/domain.ts`](../../packages/core/src/domain.ts)).

Obligación residual. El sistema de archivos del host es un sistema de archivos real; el alias es un asa verificada. Mover la ruta canónica o el alias sólo con reactivación. Cita: OWASP Top 10 A03:2021; OWASP Top 10 A04:2021.

## 6. Cortafuegos de servicio / MCP

*STRIDE: Escalada / Manipulación.* Contrabando de nombre de herramienta MCP, anulación de enrutamiento por argumentos o suplantación de primitivas de gobernanza por una ruta de servicio.

Qué hace el sistema. El inventario MCP está cerrado ([`../reference/mcp.es.md`](../reference/mcp.es.md) (EN: [`../reference/mcp.md`](../reference/mcp.md))): cinco herramientas, dos recursos; sin herramienta de aprobar, publicar, aplicar, revertir o desplegar. Los nombres se normalizan de forma insensible a mayúsculas tras colapsar separadores; los nombres vacíos y prohibidos se rechazan al registrarse y al invocarse. Las claves de argumentos que podrían anular el descriptor o filtrar una transición se rechazan; el método y la ruta siempre provienen del descriptor cerrado. El arnés del adaptador rechaza identidades de servicio / agente en `apply` con `E_AUTHORITY_FORBIDDEN`.

Obligación residual. Mantener la superficie MCP dentro de la red confiable; no registrar pasarelas de relevo MCP que evadan el inventario cerrado. Cita: OWASP LLM Top 10 LLM06:2025.

## 7. Contenido — falla cerrada

*STRIDE: Manipulación / Divulgación de información.* Contenido con *malware* o envenenado entra en la proyección.

Qué hace el sistema. La línea falla de forma cerrada ([`packages/media/src/blob-store.ts`](../../packages/media/src/blob-store.ts) · [`packages/media/src/pipeline.ts`](../../packages/media/src/pipeline.ts)): tres espacios de nombres; `video/` es de sólo lectura en V1. El escaneo y la cuarentena se ejecutan antes de cualquier codificación o promoción. Un escáner no disponible lanza `E_MALWARE_SCAN_UNAVAILABLE`; un hallazgo lanza `E_MALWARE_DETECTED`. La detección de *magic-byte* rechaza `E_MIME_SPOOFED` y `E_SIGNATURE_MISMATCH`; los presupuestos de bytes y descompresión lanzan `E_BYTES_EXCEEDED` y `E_DECOMPRESSION_BOMB`. Se exige texto alternativo en la local par (`E_ALT_MISSING_PEER_LOCALE`); las atestaciones ICC y EXIF privado son independientes (`E_ICC_ATTESTATION_MISSING`, `E_EXIF_ATTESTATION_MISSING`). La promoción es atómica por derivado; ante un fallo parcial la línea revierte antes de exponer el código original.

Obligación residual. El escáner lo despliega y lo reemplaza la operadora; el suavizado se hace en el escáner, nunca en la línea. Cita: OWASP Top 10 A03:2021; OWASP ASVS V12.

## 8. Reversión y reconciliación

*STRIDE: Repudio.* La reversión suplanta a quien aprobó originalmente, o se confunde con la propagación en vivo.

Qué hace el sistema. La reversión gobernada es una acción humana compensatoria: no repite credenciales, no emite un recibo sintético de `live`, y termina en `canonical_written`. La propuesta alcanza el estado terminal `rolled_back` y se audita como `proposal.rolled_back` ([`packages/core/src/state-machine.ts`](../../packages/core/src/state-machine.ts) · [`../reference/state-machine.es.md`](../reference/state-machine.es.md) (EN: [`../reference/state-machine.md`](../reference/state-machine.md))). La reconciliación asíncrona del despliegue sigue a la escritura canónica y reporta por separado ([`../concepts/content-boundary.es.md`](../concepts/content-boundary.es.md) (EN: [`../concepts/content-boundary.md`](../concepts/content-boundary.md))).

Obligación residual. No inventar estados intermedios `propagating` o `live`; dejar que el adaptador reporte recibos a través de la máquina de estados cerrada. Cita: OWASP ASVS V7.3.

## 9. Configuración e higiene de secretos

*STRIDE: Divulgación de información / Manipulación.* Fuga de secretos de la operadora, sustitución silenciosa al faltar un secreto o postura de cuotas débil.

Qué hace el sistema. El servidor falla de forma cerrada: las sustituciones requeridas se imponen como `${VAR:?message}` en `compose.yaml`. `loadServerConfig` analiza cada valor y lanza un código cerrado de `SERVER_CONFIG_ERROR_CODES` ([`packages/server/src/config.ts`](../../packages/server/src/config.ts)). `describeServerConfig` redacta `accessKeyId`, `secretAccessKey` y la contraseña de la URL de base de datos antes de registrar. El contexto de compilación excluye `.env`, `.env.*`, `*.pem`, `*.key`, `*.crt`, `*.p12` ([`.dockerignore`](../../.dockerignore)). Las credenciales raíz de MinIO nunca llegan a la aplicación; `minio-init` converge un usuario de aplicación con ámbito de *bucket* mediante la política `cms-app`.

Obligación residual. Rotar un secreto exige actualizar `.env` y cualquier URL embebida a la vez; la lista de rotación está en [`hardening.es.md`](hardening.es.md) (EN: [`hardening.md`](hardening.md)). Cita: OWASP Secrets Management Cheat Sheet; OWASP Top 10 A02:2021.

## 10. Separación de redes

*STRIDE: Divulgación de información / Escalada.* Tráfico este / oeste a servicios de datos o egreso externo desde los servicios de datos.

Qué hace el sistema. Dos redes de *Compose* ([`compose.yaml`](../../compose.yaml)): `cms_data` (interna, sin ingreso) aloja `postgres`, `migrations`, `minio`, `minio-init`; el servidor se une a ella para acceso a datos. `cms_egress` es la única red con ingreso externo; el servidor llega al emisor OIDC y al JWKS por ella. Los *one-shots* corren con `read_only: true` y `no-new-privileges: true`. La aplicación corre como `cms:cms` (UID / GID 10001) con `no-new-privileges: true` y `tini` como PID-1. Las *healthchecks* son sólo *loopback* ([`scripts/self-host-healthcheck.mjs`](../../scripts/self-host-healthcheck.mjs)).

Obligación residual. No cambiar los modos de red ni publicar puertos de datos sin un proxy inverso que termine TLS. Cita: OWASP Docker Top 10; CIS Docker Benchmark §6.

## 11. Auditoría

*STRIDE: Repudio / Manipulación.* Manipulación del registro de auditoría o ruptura de la cadena de custodia.

Qué hace el sistema. Los sobres de auditoría son direccionables por contenido y firmados con JWS separado ([`packages/audit/src/index.ts`](../../packages/audit/src/index.ts) · [`packages/audit/src/canonical.ts`](../../packages/audit/src/canonical.ts) · [`packages/audit/src/jws.ts`](../../packages/audit/src/jws.ts) · [`../reference/audit-envelope.es.md`](../reference/audit-envelope.es.md) (EN: [`../reference/audit-envelope.md`](../reference/audit-envelope.md))). La `append_only_violation` de almacenamiento lanza `StorageErrorCode('append_only_violation')`. El ciclo de vida de propuestas, el linaje de reversión de la máquina de estados, las transiciones de contenido, los recibos de despliegue y los recibos del adaptador se auditan a través del mismo sobre ([`../concepts/governance-and-human-authority.es.md`](../concepts/governance-and-human-authority.es.md) (EN: [`../concepts/governance-and-human-authority.md`](../concepts/governance-and-human-authority.md)) · [`../concepts/content-boundary.es.md`](../concepts/content-boundary.es.md) (EN: [`../concepts/content-boundary.md`](../concepts/content-boundary.md)) · [`../reference/media-pipeline.es.md`](../reference/media-pipeline.es.md) (EN: [`../reference/media-pipeline.md`](../reference/media-pipeline.md)) · [`../reference/adapter-sdk.es.md`](../reference/adapter-sdk.es.md) (EN: [`../reference/adapter-sdk.md`](../reference/adapter-sdk.md))).

Obligación residual. La verificación de auditoría es *offline* y determinista; las operadoras son dueñas de las claves JWS y de la ventana de retención. Cita: OWASP ASVS V7, V7.2, V7.3.

## 12. Exposición de *health* y métricas

*STRIDE: Divulgación de información.* Reconocimiento mediante `/health/*`, `/metrics` o trazas de *bearer*.

Qué hace el sistema. Cuatro rutas sin autenticar se montan antes del *middleware* de *tenant* ([`packages/server/src/index.ts`](../../packages/server/src/index.ts) · [`../reference/observability.es.md`](../reference/observability.es.md) (EN: [`../reference/observability.md`](../reference/observability.md))): `GET /v1/health`, `GET /health/live`, `GET /health/ready`, `GET /metrics`. `/health/live` devuelve sólo `{ status, service, version, timestamp }`. `/health/ready` devuelve un `ReadinessReport` con tres booleanos y detalle redactado; los fallos se exponen como los literales `database unavailable`, `object store unavailable`, `OIDC JWKS unavailable`. `/metrics` expone exactamente ocho nombres con `status` como única etiqueta; sin `tenant_id`, `actor_id`, `route`, `method` ni `locale`. El adaptador de Nodo retira `cookie` y `proxy-authorization`.

Obligación residual. Mantener estas rutas en la red operadora confiable; no proxiarlas a través de un origen público. Cita: OWASP API Security Top 10 API3; OWASP ASVS V8.

## Limitaciones

- **Pruebas de accesibilidad con participantes externos.** La validación externa es un objetivo planificado para v1.1 ([`../accessibility/statement.es.md`](../accessibility/statement.es.md) (EN: [`../accessibility/statement.md`](../accessibility/statement.md))).
- **Segundo adaptador independiente.** Un segundo adaptador es la barrera de conformidad de v1.1 ([`../reference/adapter-sdk.es.md`](../reference/adapter-sdk.es.md) (EN: [`../reference/adapter-sdk.md`](../reference/adapter-sdk.md))).
- **Despliegue respaldado por *daemon* Docker.** La configuración de *Compose* sólo se interpoló; no se ejecutó compilación ni tiempo de ejecución sobre un *daemon* vivo ([`../how-to/self-host.es.md`](../how-to/self-host.es.md) (EN: [`../how-to/self-host.md`](../how-to/self-host.md))).
- **Calendario de rotación de secretos.** La cadencia de rotación es contrato de la operadora; el *runtime* no publica uno ([`hardening.es.md`](hardening.es.md) (EN: [`hardening.md`](hardening.md))).

## Referencias OWASP

- Top 10 A01:2021 — <https://owasp.org/Top10/A01_2021-Broken_Access_Control/>
- Top 10 A02:2021 — <https://owasp.org/Top10/A02_2021-Cryptographic_Failures/>
- Top 10 A03:2021 — <https://owasp.org/Top10/A03_2021-Injection/>
- Top 10 A04:2021 — <https://owasp.org/Top10/A04_2021-Insecure_Design/>
- Top 10 A07:2021 — <https://owasp.org/Top10/A07_2021-Identification_and_Authentication_Failures/>
- API Security Top 10 — BOPLA — <https://owasp.org/API-Security/editions/2023/en/0xa3-excessive-data-exposure/>
- Secrets Management Cheat Sheet — <https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html>
- LLM Top 10 LLM06:2025 — <https://genai.owasp.org/llm-top-10/>
- RFC 8725 — <https://datatracker.ietf.org/doc/html/rfc8725>
- RFC 9457 — <https://www.rfc-editor.org/rfc/rfc9457>
