# Autoalojamiento de Handoff CMS

> [English version](self-host.md) · El inglés y el español son locales pares. Ambos archivos se publican en el mismo pull request (regla de cero desfase). Véase [`../README.es.md#desfase-cero-enes-en-el-mismo-pr`](../README.es.md#desfase-cero-enes-en-el-mismo-pr).

Esta página está dirigida a la audiencia **auto-hospedadora**: una persona operadora que levanta la pila completa en un anfitrión que controla. Está fundamentada en `compose.yaml`, `.env.example` y `Dockerfile` en la raíz del repositorio, y en el cargador de configuración del servidor en [`packages/server/src/config.ts`](../../packages/server/src/config.ts). Nada de lo que contiene esta página se ha probado en vivo contra un daemon de Docker; consulta [Qué se verificó](#qué-se-verificó) más abajo para conocer el alcance exacto de la evidencia de V1.

## Frontera de audiencia

Handoff CMS tiene tres roles operativos. Esta página atiende a la **persona auto-hospedadora** que ejecuta la pila completa de `compose.yaml`. Las audiencias adyacentes tienen su propia página:

- La **persona operadora de agencia** que ejecuta una pila Compose gestionada se cubre en [`quickstart.md`](quickstart.md) · [`.es`](quickstart.es.md) (la secuencia de siete comandos de verificación) y [`configure.md`](configure.md) · [`.es`](configure.es.md) (validación fail-closed al arrancar).
- La **persona autora** que edita contenido a través de la superficie autenticada por OIDC se cubre en [`authoring.md`](authoring.md) · [`.es`](authoring.es.md).
- La **persona integradora** que escribe un adaptador se cubre en [`../reference/adapter-sdk.es.md`](../reference/adapter-sdk.es.md) · [English](../reference/adapter-sdk.md).

Las operaciones del día 2 están documentadas en [`operate.es.md`](operate.es.md) · [English](operate.md), [`migrate.es.md`](migrate.es.md) · [English](migrate.md), [`backup-restore.es.md`](backup-restore.es.md) · [English](backup-restore.md), [`../reference/observability.es.md`](../reference/observability.es.md) · [English](../reference/observability.md) y [`../security/hardening.es.md`](../security/hardening.es.md) · [English](../security/hardening.md).

## Prerrequisitos

El levantamiento asume un único anfitrión Linux con el siguiente toolchain, fijado por el manifiesto del monorepo:

- **Docker Engine + Compose v2.** Necesario para interpretar `compose.yaml`. El archivo de compose apunta al esquema de Compose v2; los comandos de esta página asumen `docker compose` (v2).
- **Node.js ≥ 22.0.0.** Fijado en `package.json` bajo `engines.node`. La imagen Docker fija `NODE_VERSION=22.20.0` (ARG en `Dockerfile`, línea 16).
- **pnpm ≥ 9.0.0.** Fijado en `package.json` bajo `engines.pnpm`. La imagen Docker fija `PNPM_VERSION=9.15.0` (ARG en `Dockerfile`, línea 17). La declaración del gestor de paquetes es `packageManager: pnpm@9.15.0`.
- **Un emisor OIDC** al que el anfitrión pueda llegar en tiempo de ejecución. El servidor verifica `CMS_OIDC_ISSUER`, `CMS_OIDC_AUDIENCE` y `CMS_OIDC_JWKS_URL`; los algoritmos simétricos (`HS*`) y `none` se rechazan ([superficie OIDC del servidor](../../packages/server/src/config.ts#L82-L102)).

## El DAG de dos ramas de Compose

`compose.yaml` define exactamente cinco servicios dispuestos como un DAG estricto de dos ramas. Las ramas convergen solo en el servicio `server`, y el servidor no arranca hasta que ambas ramas hayan alcanzado un estado terminal saludable o de completado exitoso.

**Rama de datos (red `cms_data`, interna — sin ingreso externo):**

1. `postgres` — `postgres:16-alpine`. Variables de entorno obligatorias: `CMS_POSTGRES_DB`, `CMS_POSTGRES_USER`, `CMS_POSTGRES_PASSWORD`. Healthcheck: `pg_isready`. Volumen: `postgres_data` → `/var/lib/postgresql/data`.
2. `migrations` — de un solo uso, `postgres:16-alpine`. Lee `./packages/storage/migrations/*.sql` en modo solo lectura. Ejecuta `psql ... -v ON_ERROR_STOP=1` por migración contra `CMS_DATABASE_URL` y registra cada revisión aplicada en `public.cms_schema_migrations`. `restart: "no"`. No arranca hasta que `postgres` esté saludable.

**Rama de objetos (red `cms_data`, interna):**

3. `minio` — `minio/minio:RELEASE.2024-12-18T13-15-44Z`. Variables de entorno obligatorias: `CMS_MINIO_ROOT_USER`, `CMS_MINIO_ROOT_PASSWORD`. `MINIO_BROWSER=off`. El healthcheck usa `mc ready`. Volumen: `minio_data` → `/data`.
4. `minio-init` — de un solo uso, `minio/mc:RELEASE.2024-11-21T17-21-54Z`. Crea el bucket privado `CMS_OBJECT_BUCKET` (`mc mb --ignore-existing`), aplica `mc anonymous none` y converge una persona usuaria de aplicación con ámbito de bucket (`CMS_OBJECT_ACCESS_KEY_ID` / `CMS_OBJECT_SECRET_ACCESS_KEY`) y una política de mínimo privilegio que permite solo `s3:GetBucketLocation`, `s3:ListBucket`, `s3:ListBucketMultipartUploads` sobre el bucket, y `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:AbortMultipartUpload`, `s3:ListMultipartUploadParts` sobre sus objetos. Las reejecuciones reemplazan solo a esa persona usuaria dedicada, de modo que las credenciales rotadas toman efecto antes de que el servidor arranque. **Las credenciales raíz de MinIO nunca llegan a la aplicación.** `restart: "no"`. No arranca hasta que `minio` esté saludable.

**Servidor:**

5. `server` — compilado desde `./Dockerfile` como `cms-server:local`. Se une a `cms_data` (interna) y a `cms_egress` (la única red con ingreso externo). No arranca hasta que **las cuatro** condiciones `postgres` (saludable), `migrations` (completada con éxito), `minio` (saludable) y `minio-init` (completada con éxito) hayan alcanzado su estado terminal. Publica `${CMS_BIND_HOST}:${CMS_BIND_PORT}:${CMS_PORT}`; el puerto publicado debe seguir al puerto de enlace de la aplicación — un desajuste produce un contenedor permanentemente insaludable sin señal en los registros (`compose.yaml:296-301`).

Los volúmenes nombrados `postgres_data` y `minio_data` son el estado durable. La aplicación nunca asume un sistema de archivos de contenedor escribible.

```text
                     ┌──────────────────────┐    ┌──────────────────────────┐
                     │   rama de datos       │    │   rama de objetos        │
                     │   cms_data            │    │   cms_data               │
                     │                       │    │                          │
   postgres (salud.) ──► migrations (1 uso)   │    │ minio (saludable)        │
                     │                       │    │      │                   │
                     └───────────┬───────────┘    └──────┴─────────┬─────────┘
                                 │                                 │
                                 └──────────────┬──────────────────┘
                                                ▼
                                  ┌──────────────────────────────┐
                                  │       server                 │
                                  │  cms_data + cms_egress       │
                                  │  depends_on: 4 condiciones   │
                                  │  healthcheck: live probe     │
                                  │  publish: CMS_BIND_PORT→PORT │
                                  └──────────────────────────────┘
```

## Verificación solo de Compose (sin afirmación de daemon)

El único comando de Compose verificado en V1 es de solo interpolación y no requiere un daemon en ejecución:

```sh
docker compose -f compose.yaml config --quiet
```

Este paso valida el mapa de sustitución de Compose. La corrida verificada usó sustituciones únicamente de validación, no secretas. La imagen del contenedor no se compiló y el servidor no se ejecutó dentro de Docker. Véase [Qué se verificó](#qué-se-verificó) para conocer el libro completo de limitaciones.

## Secretos de marcador e inventario de .env

`.env.example` en la raíz del repositorio es el inventario autoritativo de variables. Trátalo como completo; no deduzcas variables obligatorias a partir de esta página. Cópialo a `.env` y sustituye cada marcador. El archivo versionado publica estos literales:

```text
CMS_POSTGRES_PASSWORD=replace-with-a-strong-database-password
CMS_MINIO_ROOT_PASSWORD=replace-with-a-strong-minio-root-password
CMS_OBJECT_SECRET_ACCESS_KEY=replace-with-a-distinct-strong-application-secret
```

Reglas concretas:

- Las cadenas `replace-with-*` son marcadores. Compose rehúsa arrancar el servidor cuando faltan valores obligatorios (`compose.yaml:269-284` usa la forma de sustitución obligatoria `${VAR:?mensaje}` para cada secreto). Los valores obligatorios producen un error duro de Compose antes de que arranque cualquier contenedor; el propio servidor además falla de forma cerrada mediante `loadServerConfig` y emite un `ServerConfigError` censurado con uno de los códigos en [`SERVER_CONFIG_ERROR_CODES`](../../packages/server/src/config.ts#L22-L30).
- Los tres valores secretos son **distintos**. Reutilizar la contraseña de Postgres para la raíz de MinIO, o la contraseña raíz de MinIO para la persona usuaria de aplicación, lo admite la gramática de sustitución pero la frontera de seguridad lo rechaza: las credenciales raíz de MinIO no deben llegar nunca a la aplicación, y la persona usuaria de aplicación tiene ámbito de bucket únicamente sobre `CMS_OBJECT_BUCKET` (`compose.yaml:202-218`).
- `CMS_DATABASE_URL` incorpora `CMS_POSTGRES_PASSWORD`; sustituye la contraseña incorporada junto con la variable independiente para que ambas se mantengan sincronizadas.
- `.env`, `.env.*` (excepto `.env.example`), `*.pem`, `*.key`, `*.crt` y `*.p12` se excluyen del contexto de compilación de Docker (`.dockerignore:19-26`). El contexto de compilación nunca ve un secreto real, aunque se haya versionado por error.
- `describeServerConfig` censura las credenciales de la tienda de objetos de la aplicación y la contraseña de la URL de la base de datos antes de cualquier registro para operadora u operador; los valores secretos nunca aparecen en el resumen diagnóstico censurado ([`config.ts:429-456`](../../packages/server/src/config.ts#L429-L456)).

El inventario completo de variables OIDC, Postgres, MinIO y cuotas se documenta en [`configure.md`](configure.md) · [`.es`](configure.es.md). Esta página no lo duplica de forma deliberada.

## Arranque fail-closed y SERVER_CONFIG_ERROR_CODES

El servidor es fail-closed: cada valor `CMS_*` obligatorio lo analiza `loadServerConfig` (`packages/server/src/config.ts`) antes de que el servidor HTTP se enlace. Ante un fallo de validación, `loadServerConfig` lanza un `ServerConfigError` que lleva un código estable legible por máquina de la unión cerrada:

```ts
export const SERVER_CONFIG_ERROR_CODES = [
  'E_CONFIG_MISSING_REQUIRED',
  'E_CONFIG_INVALID_TYPE',
  'E_CONFIG_OUT_OF_RANGE',
  'E_CONFIG_INVALID_URL',
  'E_CONFIG_INVALID_LOG_LEVEL',
] as const;
```

El conjunto se congela al cargar el módulo (`Object.freeze`) y el alias de tipo `ServerConfigErrorCode` es el tipo elemento de la unión. El error lanzado lleva una bolsa `details` con el nombre de la variable ofendida; nunca incorpora valores secretos. La forma de sustitución obligatoria de Compose `${VAR:?mensaje}` captura los valores ausentes en la capa de orquestación antes de que arranque el contenedor; el cargador del servidor captura los valores con formato inválido, los enteros fuera de rango, las URL no válidas, los niveles de registro no válidos y las listas `CMS_OIDC_ALGORITHMS` no válidas.

El contrato de arranque es:

1. Compose rehúsa arrancar cualquier servicio cuya sustitución `${VAR:?mensaje}` esté sin definir.
2. `postgres` y `minio` alcanzan un estado saludable antes de que sus dependientes arranquen.
3. `migrations` y `minio-init` completan con éxito antes de que el servidor arranque.
4. `server` invoca `loadServerConfig`; en caso de éxito se enlaza en `${CMS_BIND_HOST}:${CMS_PORT}`; en caso de fallo sale con el código estable de `ServerConfigError`.
5. El healthcheck de `server` sondea `/usr/local/bin/self-host-healthcheck.mjs live` — una sonda de vivacidad solo de proceso que no realiza E/S sobre dependencias.

## OIDC, Postgres y MinIO: qué valida el servidor

El servidor no reimplementa identidad, persistencia ni almacenamiento. Valida contratos y reenvía:

- **OIDC.** El servidor obtiene el JWKS en `CMS_OIDC_JWKS_URL`, lo almacena en caché durante `CMS_OIDC_JWKS_CACHE_SECONDS` (300 por defecto) y rechaza los algoritmos simétricos y `none`. La lista permitida se fija en el ámbito del módulo (`config.ts:246`). `CMS_OIDC_ISSUER`, `CMS_OIDC_AUDIENCE` y `CMS_OIDC_JWKS_URL` son obligatorias.
- **Postgres.** `CMS_DATABASE_URL` es obligatoria y se pasa a la capa de almacenamiento. Las migraciones las gestiona `compose.yaml:105-140`, no el servidor.
- **MinIO.** `CMS_OBJECT_ENDPOINT` (por defecto `http://minio:9000`), `CMS_OBJECT_BUCKET`, `CMS_OBJECT_ACCESS_KEY_ID` y `CMS_OBJECT_SECRET_ACCESS_KEY` son obligatorias. `CMS_OBJECT_FORCE_PATH_STYLE` vale `true` por defecto (el valor por defecto de compose coincide con el de la imagen). `CMS_OBJECT_REGION` vale `us-east-1` por defecto. Las credenciales raíz solo las usan `minio` y `minio-init`; la aplicación usa la persona usuaria dedicada con ámbito de bucket.

La matriz completa de variables y las reglas de análisis de cada valor se documentan en [`configure.md`](configure.md) · [`.es`](configure.es.md).

## Contexto de compilación de Docker

`Dockerfile` es una compilación multi-etapa (deps → compilación del monorepo → tiempo de ejecución mínimo). La etapa de ejecución:

- ejecuta el ejecutable ESM de Node 22 como persona usuaria sin privilegios root `cms:cms` (UID/GID 10001),
- envía solo el grafo de dependencias de producción materializado por `pnpm deploy --filter @cms/server --prod`,
- copia el script de healthcheck desde `scripts/self-host-healthcheck.mjs` y fija su modo a `0555`,
- define valores por defecto no secretos para las variables enumeradas bajo `ENV` (líneas 100-115), todas las cuales compose sobrescribe en tiempo de ejecución.

No se incorporan al imagen secretos ni valores `CMS_*`. El contenedor se configura exclusivamente en tiempo de ejecución mediante variables de entorno; el archivo de compose las interpola desde un `.env` gestionado al que solo la persona operadora tiene acceso (`Dockerfile:1-14`). El contexto de compilación excluye `.env`, `node_modules`, artefactos de compilación, artefactos de prueba, estado de VCS y otros pegamentos del monorepo (`.dockerignore`).

## Qué se verificó

Esta página se fundamenta en los archivos de código fuente citados arriba. El único comando relacionado con Docker que V1 ejecutó de verdad es de solo interpolación:

```sh
docker compose -f compose.yaml config --quiet
```

Ese comando valida el mapa de sustitución. No compila la imagen, no inicia el daemon ni ejercita ningún contenedor. El informe de verificación de V1 en `artifacts/g008/workspace-test-report.json` lo registra de forma explícita en su libro de limitaciones. Una compilación o ejecución en vivo respaldada por un daemon de Docker **no** forma parte de V1 y no es una afirmación de esta página.

Para obtener evidencia de despliegue en vivo, sigue las guías del día 2 de [`endurecimiento`](../security/hardening.es.md), [`migración`](migrate.es.md) y [`copia de seguridad/restauración`](backup-restore.es.md). La evidencia V1 en disco sigue limitada a los archivos fuente citados y al informe de siete comandos referenciado desde [`quickstart.es.md`](quickstart.es.md) · [English](quickstart.md); no prueba un despliegue respaldado por un daemon.

## Dónde continuar

- Configurar cada valor `CMS_*`: [`configure.md`](configure.md) · [`.es`](configure.es.md).
- La secuencia de verificación del monorepo de siete comandos (superficie de operadora): [`quickstart.md`](quickstart.md) · [`.es`](quickstart.es.md).
- La arquitectura de la pila de alojamiento (razonamiento de red y almacenamiento): [`../concepts/architecture.md`](../concepts/architecture.md) · [`.es`](../concepts/architecture.es.md).
- La frontera de contenido y el modelo de autoridad humana: [`../concepts/content-boundary.md`](../concepts/content-boundary.md) · [`.es`](../concepts/content-boundary.es.md).
- El informe de verificación: `artifacts/g008/workspace-test-report.json`.
- La unión cerrada fuente de `SERVER_CONFIG_ERROR_CODES`: [`packages/server/src/config.ts:22-30`](../../packages/server/src/config.ts#L22-L30).