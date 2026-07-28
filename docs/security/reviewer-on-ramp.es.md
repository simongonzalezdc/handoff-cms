# Rampa del revisor de seguridad

> **Audiencia:** revisores de seguridad. Esta página es un índice navegable de
> las pruebas de autoridad y los límites de contención de Handoff CMS v1.
> Registra contratos respaldados por la fuente; no añade controles ni afirma
> validación del despliegue.
>
> [English version](reviewer-on-ramp.md) · Las versiones inglesa y española
> son pares. Ambas se envían en el mismo *pull request* y ningún idioma
> sustituye al otro. Para las reglas de seguridad de fuente documental,
> consulta [`secrets-in-docs.md`](secrets-in-docs.md). La política de
> secretos se publica solo en inglés; esta rampa ES enlaza a la página EN
> para que ningún idioma sustituya al otro.

## Orden de revisión

Empieza por el [límite del contenido](../concepts/content-boundary.es.md) y el
[ciclo de autoridad humana](../concepts/governance-and-human-authority.es.md).
Después usa el índice para inspeccionar la fuente propietaria y su referencia
par. El repositorio del host sigue siendo canónico: el sistema propone,
obtiene una decisión humana vigente, escribe únicamente `canonical_source`,
registra el resultado y coordina un pulso separado de propagación en vivo. Los
campos comerciales siguen bajo coordinación y son de solo lectura para el
cliente. La reconciliación es asíncrona y de solo lectura.

| Superficie de prueba | Qué establecer | Prueba de fuente | Documentación par |
| --- | --- | --- | --- |
| Índice de autoridad | Una transición privilegiada es una transición del sistema autorizada por una persona vigente, no una capacidad de adaptador, servicio, agente o MCP. | [`packages/api/src/auth.ts`](../../packages/api/src/auth.ts), [`packages/core/src/policy.ts`](../../packages/core/src/policy.ts), [`packages/core/src/state-machine.ts`](../../packages/core/src/state-machine.ts) | [`governance-and-human-authority.es.md`](../concepts/governance-and-human-authority.es.md) · [EN](../concepts/governance-and-human-authority.md), [`threat-model.es.md`](threat-model.es.md) · [EN](threat-model.md) |
| Identidad OIDC y códigos | Verificar JWT asimétricos contra emisor, audiencia y caducidad configurados, además de `not-before` cuando exista; confirmar la unión cerrada de rechazos y la ruta de fallos sin secretos. | [`packages/server/src/auth.ts`](../../packages/server/src/auth.ts), [`packages/server/src/config.ts`](../../packages/server/src/config.ts) | [`error-codes.es.md`](../reference/error-codes.es.md) · [EN](../reference/error-codes.md), [`threat-model.es.md#2-token`](threat-model.es.md#2-token) |
| Cortafuegos MCP | Confirmar el inventario cerrado de herramientas/recursos y el cortafuegos de nombres/argumentos. MCP puede proponer o leer, pero no tiene primitivas de aprobar, publicar, aplicar, desplegar o revertir. | [`packages/mcp/src/server.ts`](../../packages/mcp/src/server.ts), [`packages/api/src/auth.ts`](../../packages/api/src/auth.ts) | [`mcp.es.md`](../reference/mcp.es.md) · [EN](../reference/mcp.md), [`threat-model.es.md#6-cortafuegos-de-servicio--mcp`](threat-model.es.md#6-cortafuegos-de-servicio--mcp) |
| Sobre de auditoría | Confirmar bytes canónicos, id de evento direccionable por contenido, JWS Ed25519 separado y rechazo de entradas malformadas. Confirmar que el esquema no tiene campos secretos. | [`packages/audit/src/index.ts`](../../packages/audit/src/index.ts), [`packages/audit/src/canonical.ts`](../../packages/audit/src/canonical.ts), [`packages/audit/src/jws.ts`](../../packages/audit/src/jws.ts) | [`audit-envelope.es.md`](../reference/audit-envelope.es.md) · [EN](../reference/audit-envelope.md), [`threat-model.es.md#11-auditoría`](threat-model.es.md#11-auditoría) |
| Cuarentena de medios | Confirmar que los bytes entrantes se validan antes de promocionar: estructura, firma/MIME, decodificación y límites de píxeles, escaneo de malware *fail-closed*, y luego atestación de derivados y promoción atómica. | [`packages/media/src/pipeline.ts`](../../packages/media/src/pipeline.ts), [`packages/media/src/blob-store.ts`](../../packages/media/src/blob-store.ts) | [`media-pipeline.es.md`](../reference/media-pipeline.es.md) · [EN](../reference/media-pipeline.md), [`threat-model.es.md#7-contenido--falla-cerrada`](threat-model.es.md#7-contenido--falla-cerrada) |
| Confinamiento de alias y rutas | Confirmar una ruta canónica, una lista cerrada de derivados, solo `alias_symlink`, confinamiento al repositorio, ausencia de traversal/escape/bucle y ausencia de escrituras directas a alias o derivados. | [`packages/adapter-sdk/src/index.ts`](../../packages/adapter-sdk/src/index.ts), [`packages/adapter-sdk/src/conformance.ts`](../../packages/adapter-sdk/src/conformance.ts), [`packages/adapter-cerafica/src/symlink.ts`](../../packages/adapter-cerafica/src/symlink.ts), [`packages/media/src/blob-store.ts`](../../packages/media/src/blob-store.ts) | [`content-boundary.es.md`](../concepts/content-boundary.es.md) · [EN](../concepts/content-boundary.md), [`adapter-sdk.es.md`](../reference/adapter-sdk.es.md) · [EN](../reference/adapter-sdk.md), [`threat-model.es.md#5-confinamiento-de-ruta-y-alias`](threat-model.es.md#5-confinamiento-de-ruta-y-alias) |
| Separación de red | Confirmar que los servicios de datos están en una red solo interna y que únicamente el servidor se une a la red de salida para OIDC/JWKS; inspeccionar restricciones de contenedores de una sola ejecución. | [`compose.yaml`](../../compose.yaml), [`Dockerfile`](../../Dockerfile) | [`threat-model.es.md#10-separación-de-redes`](threat-model.es.md#10-separación-de-redes), [`hardening.es.md`](hardening.es.md) · [EN](hardening.md) |
| Endurecimiento del tiempo de ejecución | Confirmar configuración *fail-closed*, cuotas de cuerpo/velocidad, diagnósticos ocultos, registros sin PII, límites de salud/métricas y exclusiones del contexto de compilación. | [`packages/server/src/config.ts`](../../packages/server/src/config.ts), [`packages/server/src/index.ts`](../../packages/server/src/index.ts), [`.dockerignore`](../../.dockerignore) | [`configure.es.md`](../how-to/configure.es.md) · [EN](../how-to/configure.md), [`observability.es.md`](../reference/observability.es.md) · [EN](../reference/observability.md), [`threat-model.es.md#9-configuración-e-higiene-de-secretos`](threat-model.es.md#9-configuración-e-higiene-de-secretos) |

Las páginas de referencia enlazadas sirven para navegar la evidencia, no para
sustituir la lectura de la fuente. Una página puede decir *verificado* solo al
citar el artefacto de evidencia del espacio de trabajo; esta rampa usa
*confirmar* e *inspeccionar* para los pasos de revisión.

## Notas de prueba

### 1. Autoridad y pulsos de estado

La API es el transporte de autoridad único sobre core y almacenamiento. La
fachada de autoridad rechaza identidades de servicio y con capacidad MCP para
`approve`, `publish` y `rollback` antes de evaluar la política, usando
`E_SERVICE_APPROVAL_FORBIDDEN` y `E_MCP_APPROVAL_FORBIDDEN`. La política aún
comprueba concesiones, versiones, roles, capacidades de campo y reglas de
autoaprobación. Una identidad humana delegada lleva una ventana temporal que
se comprueba de nuevo en la solicitud; delegar no convierte una credencial de
servicio en una decisión humana.

Una transición de publicación escribe la fuente canónica del host y registra
`canonical_written`. Un recibo de despliegue es un pulso asíncrono separado.
Un recibo fallido deja la propuesta en `canonical_written`; no inventa
`propagating` ni `live`. Una reversión humana vigente es una acción comprobada
por política y termina la propuesta en `rolled_back`; no reproduce credenciales
ni suplanta al aprobador original. Inspecciona la unión de estados y el
tratamiento de rutas de la API antes de considerar un recibo en vivo como
prueba de una escritura canónica.

### 2. Prueba OIDC y códigos cerrados

El verificador acepta solo algoritmos asimétricos configurados (variantes RS,
ES o PS); rechaza `none` y `HS*`. Comprueba `iss`, `aud`, `exp` y `nbf` mediante
el verificador respaldado por JWKS, con caché y tiempo de consulta acotados.
Las declaraciones posteriores a la verificación también exigen `sub`, `iat`,
`tenantId`, `actorId`, `kind` y `scope`; `kind` es `human` o `service`. El
verificador nunca registra ni devuelve el valor del portador.

Revisa los miembros exactos de `SERVER_AUTH_ERROR_CODES` en
[`error-codes.es.md`](../reference/error-codes.es.md) en vez de aceptar un
nombre inventado. Los valores relevantes son `E_TOKEN_MISSING`,
`E_TOKEN_MALFORMED`, `E_TOKEN_BAD_SIGNATURE`, `E_TOKEN_BAD_AUDIENCE`,
`E_TOKEN_BAD_ISSUER`, `E_TOKEN_EXPIRED`, `E_TOKEN_NOT_YET_VALID`,
`E_TOKEN_BAD_ALGORITHM` y `E_OIDC_JWKS_UNAVAILABLE`. La rotación de claves del
emisor y la prueba de identidad siguen siendo responsabilidades del operador
y del emisor; el producto consume las declaraciones validadas y no exagera la
garantía aguas arriba.

### 3. Cortafuegos de nombres y argumentos MCP

La proyección MCP expone exactamente cinco herramientas (`proposeEdit`,
`suggestAltText`, `suggestCrop`, `generatePreview`, `submitApprovalRequest`) y
dos recursos de lectura (`proposal://{id}`, `health://`). El registro y la
invocación rechazan nombres vacíos y variantes separadas de aprobación,
publicación, aplicación, despliegue, reversión, fuerza, administración,
* bypass*, firma, solicitud arbitraria, proxy, fetch, ejecución y transición,
tras normalizar separadores.

Los argumentos son objetos planos. Se rechazan claves que podrían sustituir un
descriptor o infiltrar una ruta/acción (`method`, `path`, `url`, `endpoint`,
`target`, `action`, `op`, `operation`, `verb`, `route`, `request`, `raw`,
`override`, `bypass`, `force`, `patch`, `transition`, `forward`, `proxy`,
`exec`, `run`, `invoke`, `http`, `fetch`, `send` y variantes de verbos
privilegiados). Las llamadas usan el método y la ruta registrados, nunca una
ruta proporcionada por quien llama. La herramienta de solicitud de aprobación
solo avisa a una persona externa; no cambia el estado de aprobación.

### 4. Sobre de auditoría y cadena de custodia

`AuditEvent` vincula inquilino, actor, persona delegada opcional, propuesta y
su hash de contenido, aprobación y bandera de autoaprobación, resultado del
host, resultado de despliegue y linaje de reversión. Los identificadores y
hashes de artefactos requeridos son valores SHA-256 hexadecimales minúsculos.
`buildEvent` valida y devuelve una copia estructural; `signEvent` firma bytes
canónicos con un JWS separado; `verifyEnvelope` devuelve `false` para forma,
hashes o ids discordantes, cabeceras protegidas inválidas o firma inválida,
en lugar de aceptar evidencia parcial. El contrato del sobre dice
explícitamente que nunca almacena secretos. La violación de solo anexado es un
rechazo separado registrado por la capa de almacenamiento.

### 5. Cuarentena y promoción de medios

La tubería de medios gobernados valida la estructura antes de revelar pistas de
autorización, y luego aplica límite de bytes, firma mágica y coincidencia MIME,
límites de decodificación/dimensiones/píxeles, validación de foco/recorte y
escaneo de malware. Los errores del escáner, el veredicto no disponible o el
veredicto no limpio permanecen en `quarantine`; no se promocionan en silencio.
Cada derivado se codifica y atestigua antes de que cualquier objeto publicado
sea visible. La promoción es atómica por objeto y una promoción parcial se
limpia o termina en cuarentena. El éxito atestigua conservación ICC y retirada
de EXIF de privacidad. La mutación de vídeo se rechaza en el espacio de vídeo
de solo lectura de v1.1. El texto alternativo requiere el par de idiomas salvo
para imágenes decorativas; la ausencia de `en` o `es` se rechaza sin valores
predeterminados silenciosos.

### 6. Confinamiento de alias y rutas

Un vínculo tiene un único `canonical_source`, una lista cerrada no vacía de
`derived_artifacts[]` y un contrato explícito de regeneración. v1 solo reconoce
`alias_symlink`. La activación rechaza punteros canónicos ambiguos, derivados
vacíos, alias propios, objetivos que escapan del repositorio, ciclos y
objetivos de alias que colisionan con la fuente canónica. El verificador
Cerafica inspecciona el sistema real (`lstat`, `readlink`, `realpath`) y rechaza
alias ausentes, rotos, retargeted, escapados, en bucle o archivos regulares.

`reconcile` vuelve a verificar el alias y el hash canónico y nunca escribe.
`apply` solo puede escribir la fuente canónica; las escrituras directas al
alias o a un derivado se rechazan antes de tocar el host. Las claves de medios
están ligadas al inquilino y rechazan rutas absolutas, segmentos de traversal,
NUL, escapes de enlace y operaciones entre inquilinos. El host sigue siendo la
fuente de verdad; los alias servidos son manejadores verificados, no punteros
editables.

### 7. Red y endurecimiento del tiempo de ejecución

En `compose.yaml`, `cms_data` es solo interna y contiene Postgres, MinIO y
los inicializadores de una sola ejecución. `cms_egress` es la red con salida
externa y solo el servidor se une a ambas para alcanzar el endpoint OIDC/JWKS
configurado. La migración y el inicializador de MinIO son de una sola
 ejecución, de solo lectura y usan `no-new-privileges`; los datos de Postgres y
MinIO viven en volúmenes con nombre. El proxy inverso y la terminación TLS son
responsabilidades del operador, no implicaciones de esta topología.

`loadServerConfig` exige los valores necesarios y rechaza URL, enteros,
idiomas, niveles de registro y listas de algoritmos JWS malformados. Los
diagnósticos ocultan credenciales del almacén de objetos y credenciales/ruta/
consulta de la URL de base de datos. El límite Node aplica cuotas de cuerpo y
de origen antes de la API; los registros son estructurados y omiten valores
portadores. `/health/live`, `/health/ready` y `/metrics` son superficies del
operador con salida acotada; mantenlas en una red de confianza. `.dockerignore`
excluye archivos de entorno y extensiones de claves privadas del contexto de
compilación. El daemon de Docker no se ejecutó para esta revisión documental,
por lo que esta página no afirma un contenedor vivo.

## Lista de salida del revisor

- [ ] El índice de autoridad tiene un enlace de fuente y una página par para
      cada superficie de prueba.
- [ ] Cada transición privilegiada se rastrea hasta una decisión humana
      vigente y un borde de la máquina de estados; adaptadores, servicios,
      agentes y MCP no se tratan como autoridad.
- [ ] Se revisan las comprobaciones OIDC y la unión cerrada exacta sin copiar
      token, secreto del emisor, inquilino ni cuenta.
- [ ] Los nombres y claves de argumentos MCP se comprueban contra el
      cortafuegos cerrado; no se supone una ruta arbitraria.
- [ ] La verificación de auditoría cubre bytes canónicos, id de evento, firma,
      enlaces de hash, linaje de reversión y persistencia de solo anexado.
- [ ] Los fallos de medios permanecen en cuarentena y ningún derivado se sirve
      antes de la validación y atestación completas.
- [ ] Se comprueba el confinamiento de alias, canónico, derivados y rutas de
      inquilino; `reconcile` es de solo lectura y `apply` solo canónico.
- [ ] Se revisan pertenencia de redes Compose, restricciones de una ejecución,
      ocultación de configuración, cuotas, exposición de salud/métricas y
      exclusiones de contexto sin afirmar ejecución de Docker.
- [ ] Las páginas EN/ES existen como pares, todos los enlaces son relativos y
      ningún idioma sustituye silenciosamente al otro.
- [ ] Los ejemplos cumplen la [política de secretos](secrets-in-docs.md):
      solo marcadores `replace-with-*`, nunca identificadores ni credenciales
      reales. La página de secretos se publica solo en inglés; esta rampa ES
      enlaza a la página EN para que ningún idioma sustituya al otro.

## Alcance y limitaciones

Esta rampa se basa en la fuente. No prueba la autenticación del emisor OIDC,
la protección de ramas del repositorio host, TLS del proxy inverso, la cadencia
de rotación de secretos del operador ni un despliegue Docker vivo. Consulta
las [limitaciones del modelo de amenaza](threat-model.es.md#limitaciones) y el
libro de evidencia al hacer afirmaciones sobre ejecución, no solo sobre la
forma de la fuente.

## Referencias OWASP

Todas las referencias externas de esta sección se consultaron el 2026-07-28.

- OWASP Top 10 A01:2021, [Broken Access Control](https://owasp.org/Top10/A01_2021-Broken_Access_Control/).
- OWASP Top 10 A02:2021, [Cryptographic Failures](https://owasp.org/Top10/A02_2021-Cryptographic_Failures/).
- OWASP Top 10 A03:2021, [Injection](https://owasp.org/Top10/A03_2021-Injection/).
- OWASP Top 10 A04:2021, [Insecure Design](https://owasp.org/Top10/A04_2021-Insecure_Design/).
- OWASP Top 10 A07:2021, [Identification and Authentication Failures](https://owasp.org/Top10/A07_2021-Identification_and_Authentication_Failures/).
- OWASP, [Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html).
- OWASP LLM Top 10 LLM06:2025, [Excessive Agency](https://genai.owasp.org/llm-top-10/).
- OWASP ASVS, [V7 Error Handling and Logging](https://owasp.org/www-project-application-security-verification-standard/).
