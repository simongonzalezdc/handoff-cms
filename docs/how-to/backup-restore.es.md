# Copia de seguridad y restauración

> [English version](backup-restore.md) · El inglés y el español son locales pares. Ambos archivos se publican en el mismo pull request (regla de cero desfase). Véase [`../README.md#same-pr-enes-zero-lag`](../README.md#same-pr-enes-zero-lag).

Esta página está dirigida a las audiencias de **autoalojamiento** y **operador de agencia**. Está fundamentada en `compose.yaml` (servicios `postgres`, `minio`, `migrations`, `minio-init`, `server`) y en el esquema de Postgres en [`packages/storage/src/schema.ts`](../../packages/storage/src/schema.ts). Nada de esta página afirma un daemon Docker en vivo: el informe de verificación de V1 en `artifacts/g008/workspace-test-report.json` solo ejecutó `docker compose -f compose.yaml config --quiet`, la imagen no se compiló y el servidor no se ejecutó dentro de Docker. Los procedimientos siguientes describen la forma en disco y el contrato entre componentes; ejecutarlos sobre un stack en vivo es responsabilidad del operador.

## Límite de audiencia

Handoff CMS tiene tres roles operativos. Esta página aborda al **autoalojador** que ejecuta el stack completo de `compose.yaml` y al **operador de agencia** que ejecuta un stack de compose administrado. Las audiencias adyacentes viven en sus propias páginas:

- El **autor** que edita contenido a través de la superficie autenticada por OIDC está cubierto por [`authoring.md`](authoring.md) · [`.es`](authoring.es.md).
- La **persona integradora** que escribe un adaptador está cubierta por [`../reference/adapter-sdk.es.md`](../reference/adapter-sdk.es.md) · [English](../reference/adapter-sdk.md).
- La **persona revisora de seguridad** está cubierta por [`../security/reviewer-on-ramp.es.md`](../security/reviewer-on-ramp.es.md) · [English](../security/reviewer-on-ramp.md).

Los estados del ciclo de vida, el momento de escritura canónica y el estado terminal `rolled_back` se documentan por separado en [`../concepts/governance-and-human-authority.md`](../concepts/governance-and-human-authority.md) · [`.es`](../concepts/governance-and-human-authority.es.md) y en [`../concepts/content-boundary.md`](../concepts/content-boundary.md) · [`.es`](../concepts/content-boundary.es.md). Esta página es intencionalmente acotada: el estado durable de los dos servicios de datos y el límite entre las restauraciones de PostgreSQL + MinIO y la repetición upstream que no pueden realizar.

## Qué es estado durable

El stack de compose expone exactamente dos volúmenes con nombre (`compose.yaml:46-50`):

| Volumen | Respaldado por | Contenido |
| --- | --- | --- |
| `postgres_data` | `cms_postgres_data` | Aquí vive el esquema de Drizzle de `@cms/storage`. Tablas: `tenants`, `actors`, `region_bindings`, `proposals`, `approvals`, `revisions`, `publications`, `deploy_receipts`, `audit_events`, `idempotency_records`. Columnas jsonb congeladas `canonical_source`, `derived_artifacts[]`, `regeneration_contract` en `region_bindings`. Las restricciones CHECK a nivel de tabla hacen cumplir la lista permitida de modos de regeneración y el alfabeto `state` de las propuestas (`schema.ts:177-240`, `schema.ts:275-327`). |
| `minio_data` | `cms_minio_data` | El bucket compatible con S3 `CMS_OBJECT_BUCKET` (por defecto `cms-content`). Blobs de medios gobernados y las derivadas con EXIF eliminado / ICC preservado producidas por `@cms/media`. El bucket es privado (`mc anonymous set none` en `minio-init`). |

Los dos volúmenes son **independientemente durables**. No existe una transacción entre volúmenes; la aplicación nunca asume un sistema de archivos de contenedor escribible. Una copia de seguridad que capture uno sin el otro es parcial y debe etiquetarse como tal.

## Qué queda fuera de alcance

- **Consistencia en caliente.** Una instantánea consistente tomada **solo** a nivel del volumen de Linux (por ejemplo, un `rsync` contra el `postgres_data` montado en bind mientras Postgres se ejecuta) **no** es una copia de seguridad consistente. El directorio de datos de Postgres se modifica continuamente; leerlo a mitad de escritura es inseguro. Los procedimientos siguientes congelan el directorio de datos con las propias herramientas de la aplicación, no a nivel de volumen.
- **Repetición upstream.** El CMS no reconstruye estado durable a partir de una fuente upstream. El contenido canónico del host es propiedad del host, no del CMS; el paquete de `(canonical_source, derived_artifacts, regeneration_contract)` vive en `region_bindings`. Una restauración que elimine las filas de `region_bindings` pero conserve el blob de `minio_data` no sabe a dónde pertenece el blob.
- **Comportamiento del daemon Docker.** Una puesta en marcha de `docker compose` en vivo, un `docker exec` o un `docker run` contra los propios contenedores de la aplicación **no** está verificado en V1. La configuración de Compose se valida solo por interpolación; la imagen no se compiló y la aplicación no se ejecutó dentro de Docker. Los comandos siguientes están escritos contra los binarios del lado host de Postgres y MinIO; la sección [Secuencia administrada por el operador](#secuencia-administrada-por-el-operador) describe el contrato, no un entorno verificado.
- **Exfiltración de secretos.** Las contraseñas de Postgres, las credenciales raíz de MinIO y las credenciales del usuario de aplicación con alcance de bucket son administradas por el operador. La copia de seguridad y la restauración deben mantener estas credenciales en sincronía con el estado durable.

## Instantánea de los dos volúmenes sobre un límite consistente

El límite de copia de seguridad elegido es un **par en quiescencia**: se detiene el contenedor `server` (para que no se escriban nuevas propuestas), luego se captura el directorio de datos de Postgres con la propia `pg_basebackup` de Postgres (o equivalente que admita el conjunto de herramientas de Postgres del operador), luego se copia el directorio `minio_data`. Los dos artefactos se etiquetan con la misma marca de tiempo. Son **consistentes a través del par**, no **atómicamente sincrónicos**: la instantánea de Postgres es internamente consistente por sí sola; la instantánea de MinIO es internamente consistente por sí sola; las dos se alinean por la marca de tiempo de reloj.

Si el operador usa en su lugar una instantánea a nivel de bloques del sistema de archivos (LVM/ZFS/btrfs) contra los volúmenes del host, la instantánea debe tomarse **antes** de que el servidor se vuelva a iniciar, para que la base de datos en vivo nunca escriba a través de una imagen congelada. Esta página no respalda ninguna estrategia específica de instantánea de sistema de archivos; afirma el principio de que la instantánea debe ser internamente consistente **por volumen** y alineada a la misma marca de tiempo de reloj por par.

Una instantánea consistente de Postgres es la producida por `pg_basebackup` (o `pg_dump` para un volcado solo lógico) contra el daemon en ejecución, o por la propia API de copia de seguridad en línea del daemon. La instantánea **no** es un `rsync` contra el directorio mientras Postgres está escribiendo. Tras verificar la instantánea, el servidor puede volver a iniciarse.

Una instantánea consistente de MinIO es la capturada leyendo el bucket fuera de línea mediante `mc` contra un daemon detenido, o tomando la instantánea del sistema de archivos del host en el momento en que el proceso de MinIO se congela. MinIO recomienda detener el daemon antes de capturar el directorio de datos; la aplicación misma no depende de MinIO estando en línea durante la breve ventana entre las dos instantáneas.

## Límite de la restauración

La restauración es una **repetición progresiva en dos pasos**. No hay transacción entre volúmenes; la instantánea de Postgres se restaura primero, luego el bucket de MinIO y luego se inicia la aplicación. El orden es fijo porque la aplicación lee Postgres primero y MinIO segundo; el orden inverso arriesga que la aplicación haga referencia a un bucket cuyo contenido se queda atrás respecto a la fila de auditoría que los nombra.

Tras la restauración:

1. La versión de la aplicación debe ser compatible con el esquema restaurado. Las migraciones de Postgres se registran en `public.cms_schema_migrations` ([`compose.yaml:122-134`](../../compose.yaml#L122-L134)); antes de iniciar una versión posterior de la aplicación, ejecuta la puerta de migración documentada con `docker compose run --rm migrations`. Este comando es orientación operativa, no evidencia V1 respaldada por un daemon.
2. La traza de auditoría está intacta. Las filas de `audit_events` son append-only y con hash de contenido; la firma Ed25519 JWS opcional se registra por separado. Un registro de auditoría restaurado es el mismo registro de auditoría que produjo el host; no es necesario repetir la fila de auditoría.
3. El contenido canónico del host queda intacto por la restauración. El CMS no es propietario del host; la copia de seguridad es la **proyección gobernada** de la aplicación sobre el host, no una copia de la fuente de verdad del host. Un host cuyo `inventory/products.json` haya cambiado desde la instantánea queda fuera del alcance de la restauración.
4. El ciclo de vida de la propuesta se reanuda desde el estado persistido. Una propuesta en `canonical_written` en el momento de la instantánea sigue en `canonical_written` tras la restauración; una propuesta en `live` sigue en `live`; una propuesta en `rolled_back` es terminal `rolled_back` y no se permite ninguna acción posterior. La máquina de estados se reconstruye completamente desde las filas de la base de datos; no hay transición en memoria que sobreviva a un reinicio.

## Cómo se ve el éxito

Tras la restauración, el operador debe verificar tres cosas en orden:

1. `GET /v1/health` devuelve `200` con el locale negociado (`en` o `es`), lo que solo prueba que el proceso de la API está vivo. Esta ruta no autenticada no lee Postgres, MinIO, filas de auditoría ni filas de publicación ([`packages/api/src/index.ts:145-153`](../../packages/api/src/index.ts#L145-L153)).
2. Una sonda `proposal.get` contra una propuesta reciente devuelve el mismo `state` y `version` que existían antes de la instantánea. Las protecciones optimistas `If-Match` en los endpoints de transición de estado siguen siendo válidas porque la `version` se lee de la base de datos.
3. El one-shot `minio-init` y el usuario de aplicación con alcance de bucket siguen en el estado correcto. La política de mínimos privilegios sobre `CMS_OBJECT_BUCKET` no cambia porque el contenido del bucket se restaura tal cual; la política tiene alcance de bucket y sobrevive a la restauración.

## Secuencia administrada por el operador

Los comandos siguientes describen el **contrato** entre componentes, no un entorno verificado. Están escritos contra los binarios del lado host de Postgres y MinIO; el operador es responsable de la decisión de ejecución de invocarlos contra un stack en vivo. El daemon Docker no está verificado y la aplicación no se ejecutó dentro de Docker en V1.

### Pre-vuelo: detener la aplicación

La aplicación debe estar en quiescencia antes de tomar la instantánea. El procedimiento exacto de parada es administrado por el operador; el contrato es que el contenedor `server` no se está ejecutando mientras se toma la instantánea. Las nuevas propuestas no se aceptan en el estado detenido; los despliegues en curso se reportan como `failed` mientras el servidor está caído, y la propuesta permanece en `canonical_written` hasta que el servidor regresa y se ejecuta una reconciliación.

### Instantánea de Postgres

```sh
# Sustituya por las credenciales administradas por el operador y la ruta de destino.
# Este comando describe el contrato; no pegue secretos reales en un archivo versionado.
pg_basebackup \
  --dbname="$CMS_DATABASE_URL" \
  --format=tar \
  --pgdata="./snapshots/postgres-$(date -u +%Y%m%dT%H%M%SZ)" \
  --wal-method=stream \
  --checkpoint=fast \
  --progress
```

La copia base es internamente consistente; el flujo WAL se incluye porque se estableció `--wal-method=stream`. El operador valida la instantánea ejecutando `pg_verifybackup` contra el tarball producido antes de que el servicio de Postgres se reinicie. Una instantánea que falle la verificación no es una copia de seguridad.

### Instantánea de MinIO

```sh
# Sustituya por el endpoint administrado por el operador, las credenciales y el bucket de destino.
# Este comando describe el contrato; no pegue secretos reales en un archivo versionado.
mc alias set cms "$CMS_OBJECT_ENDPOINT" "$CMS_OBJECT_ACCESS_KEY_ID" "$CMS_OBJECT_SECRET_ACCESS_KEY"
mc mirror --preserve --remove --overwrite \
  "cms/$CMS_OBJECT_BUCKET" \
  "./snapshots/minio-$(date -u +%Y%m%dT%H%M%SZ)/"
```

El comando mirror es una **copia del lado host** del contenido del bucket. No conserva las políticas del bucket, la configuración de ciclo de vida ni el usuario de aplicación con alcance de bucket; el operador debe reaplicarlos por separado si la restauración monta una instancia nueva de MinIO. El contenido del bucket mismo es el estado durable bajo el contrato de la aplicación; la política y el usuario son administrados por el operador.

### Restauración de Postgres

```sh
# Sustituya por el directorio de datos administrado por el operador y la ruta de la instantánea.
# Este comando describe el contrato; no pegue secretos reales en un archivo versionado.
pg_ctl -D "$CMS_POSTGRES_DATA_DIR" stop -m fast
rm -rf "$CMS_POSTGRES_DATA_DIR"
tar -xf "./snapshots/postgres-YYYYMMDDTHHMMSSZ/base.tar" -C "$CMS_POSTGRES_DATA_DIR"
pg_ctl -D "$CMS_POSTGRES_DATA_DIR" start
```

La restauración sobrescribe el directorio de datos local. El usuario de la aplicación (`CMS_POSTGRES_USER`) y la base de datos (`CMS_POSTGRES_DB`) existen en el directorio restaurado porque se crearon en `initdb`; el operador no necesita recrearlos. La aplicación lee la disposición de tablas de Drizzle desde el esquema; la disposición es lo que contiene la instantánea.

### Restauración de MinIO

```sh
mc mirror --preserve --overwrite \
  "./snapshots/minio-YYYYMMDDTHHMMSSZ/" \
  "cms/$CMS_OBJECT_BUCKET"
```

El mirror empuja la instantánea de vuelta al bucket configurado. El operador también debe:

- Volver a ejecutar el one-shot `minio-init` si se perdió el usuario de aplicación con alcance de bucket (la base de datos local de usuarios del contenedor MinIO no forma parte de la instantánea del bucket).
- Reaplicar la política de mínimos privilegios sobre `CMS_OBJECT_BUCKET` si el bucket mismo fue recreado.

### Iniciar la aplicación

La aplicación se inicia mediante el perfil de compose del operador. El contrato es que `loadServerConfig` se ejecute con éxito (los valores `CMS_*` requeridos están presentes y bien formados), los healthchecks de `postgres` y `minio` reporten healthy, los one-shots `migrations` y `minio-init` hayan terminado con éxito y entonces `server` sondee `/v1/health` hasta que devuelva 200.

## Lo que la restauración no puede hacer

La restauración **no** es una repetición upstream. El CMS no recupera el contenido canónico del host desde la base de datos; el host es propietario del camino canónico. Los siguientes escenarios están explícitamente fuera de alcance:

- **Se perdió el archivo canónico del host.** El CMS no re-deriva `inventory/products.json` desde la base de datos de la aplicación. El VCS, la instantánea o la copia de seguridad del host es la fuente canónica. La aplicación reporta la **última propuesta conocida** que escribió el archivo canónico; no reconstruye el archivo.
- **Se perdió la fila de `region_bindings`.** La restauración no descubre vinculaciones. Las columnas congeladas `canonical_source`, `derived_artifacts[]`, `regeneration_contract` se persisten en la base de datos; son parte del estado durable y se restauran junto con Postgres. Una restauración que elimine las vinculaciones pero conserve el bucket es una restauración parcial.
- **Se perdió un despliegue en curso.** Un recibo de despliegue es un reporte asíncrono del lado host. La tabla de recibos (`deploy_receipts`) es durable; el recibo mismo se restaura junto con Postgres. El estado de despliegue de la propuesta refleja el **último recibo persistido**; los recibos que estaban en curso en el momento de la instantánea se registran como `pending` si la instantánea se tomó antes de que se escribiera el recibo, y como `succeeded`/`failed` si el recibo ya se había escrito y la instantánea se tomó después.
- **Se perdió parcialmente el registro de auditoría.** El sobre de auditoría tiene hash de contenido y firma JWS; un registro de auditoría parcial no puede reconstruirse. La restauración es todo-o-nada para la tabla `audit_events`.

## Notas de reconciliación

La máquina de estados de propuestas ([`packages/core/src/state-machine.ts`](../../packages/core/src/state-machine.ts)) es la autoridad del ciclo de vida. Tiene un estado inicial (`draft`) y un estado terminal (`rolled_back`); `proposed` se alcanza mediante `submit`. La reconciliación registra si convergió el estado en vivo del host; no escribe bytes canónicos. Desde `reconcile_failed`, la única salida válida es `rollback` al estado terminal `rolled_back`.

Una restauración carga el estado persistido de las propuestas y los recibos de despliegue tal como fueron capturados; no dispara una reconciliación implícita. Inspecciona los recibos restaurados y el estado actual del host, y luego invoca la ruta gobernada explícita de reconciliación solo desde un estado que lo permita. La tabla de recibos sigue siendo el informe autoritativo del despliegue.

## Limitaciones

- **Sin compilación ni ejecución respaldada por un daemon Docker.** La configuración de Compose se valida solo por interpolación; la imagen del contenedor no se compiló y el servidor no se ejecutó dentro de Docker. Los comandos anteriores describen los binarios del lado host de Postgres y MinIO; ejecutarlos contra los propios contenedores de la aplicación es administrado por el operador.
- **Sin afirmación de consistencia en caliente.** Una instantánea consistente es la producida por la propia API de copia de seguridad en línea de Postgres y por la propia copia del bucket de MinIO, **no** por una instantánea en vivo del sistema de archivos contra un contenedor en ejecución. Los procedimientos anteriores congelan el directorio de datos con las propias herramientas de la aplicación, no a nivel de volumen.
- **Sin un segundo adaptador.** El adaptador de referencia de Cerafica es el único adaptador en V1. Los procedimientos de copia de seguridad y restauración cubren los bytes, la base de datos y la tabla de recibos; un segundo adaptador que introduzca una superficie durable nueva (por ejemplo, una caché de borde CDN o un CMS descendente) es una puerta de validación de contrato de v1.1, no un reclamo de cierre de V1.
- **Validación externa con participantes es v1.1.** El producto se describe en el catálogo de i18n como "neurodivergent-accessible by design"; la validación externa no está en V1.

## Dónde continuar

- Poner en marcha el stack: [`self-host.md`](self-host.md) · [`.es`](self-host.es.md) y [`quickstart.md`](quickstart.md) · [`.es`](quickstart.es.md).
- Configurar cada valor `CMS_*`: [`configure.md`](configure.md) · [`.es`](configure.es.md).
- Ciclo de vida, autoridad humana y el momento de escritura canónica: [`../concepts/governance-and-human-authority.md`](../concepts/governance-and-human-authority.md) · [`.es`](../concepts/governance-and-human-authority.es.md).
- Frontera de contenido y el contrato `alias_symlink`: [`../concepts/content-boundary.md`](../concepts/content-boundary.md) · [`.es`](../concepts/content-boundary.es.md).
- Glosario: [`../project/glossary.md`](../project/glossary.md) · [`.es`](../project/glossary.es.md).
- Informe de verificación: `artifacts/g008/workspace-test-report.json`.
