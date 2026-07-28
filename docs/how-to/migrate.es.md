# Migrar Handoff CMS

> [English version](migrate.md) · El inglés y el español son locales pares. Ambos archivos se publican en el mismo pull request (regla de cero desfase). Véase [`../README.md#same-pr-enes-zero-lag`](../README.md#same-pr-enes-zero-lag).

Esta página documenta cómo evoluciona el esquema de `@cms/storage`, quién es dueño de la puerta de migración, y qué puede y qué no puede hacer un operador con una migración aplicada. Es el complemento de actualización de esquema de [`operate.md`](operate.md) · [`.es`](operate.es.md); las señales de tiempo de ejecución de día 2, la cadencia de instantáneas y el reparto de roles entre el operador de agencia y el autoalojador viven allí y no se duplican aquí. La puesta en marcha, las variables de configuración y la secuencia de verificación de siete comandos viven en [`self-host.md`](self-host.md) · [`.es`](self-host.es.md), [`configure.md`](configure.md) · [`.es`](configure.es.md) y [`quickstart.md`](quickstart.md) · [`.es`](quickstart.es.md) respectivamente.

Esta página está anclada en [`packages/storage/migrations/0001_governance.sql`](../../packages/storage/migrations/0001_governance.sql), el servicio de un solo disparo `migrations` en [`compose.yaml`](../../compose.yaml#L102-L140), y la nota del operador [`packages/server/migrations/README.txt`](../../packages/server/migrations/README.txt). La puerta de migración no se ha ejercitado contra un daemon de Docker en vivo; véase [Qué se verificó](#qué-se-verificó) para el alcance exacto de V1.

## Frontera de audiencias

- El **operador de agencia** ejecuta el stack de compose gestionado y es el operador de día 2 de la puerta de migración. Es dueño de la instantánea del volumen, de la dependencia `migrations: service_completed_successfully`, y del diagnóstico de arranque redactado.
- El **autoalojador** ejecuta el stack completo en un host que le pertenece. Es dueño además de la ruta de restauración del volumen nombrado y de la replicación fuera del host de cualquier instantánea aplicada.
- El **autor** nunca toca el esquema. Los cambios de esquema son tickets de trabajo del operador; el autor expone un cambio de comportamiento a través del flujo de propuestas bilingüe descrito en [`authoring.md`](authoring.md) · [`.es`](authoring.es.md).
- El **integrador** que escribe un segundo adaptador (puerta de conformidad v1.1 planificada) interactúa con el esquema a través de la superficie de contrato del SDK del adaptador, no a través de `psql` contra `cms_postgres_data`.

## Fuente de verdad y la puerta de un solo disparo

Las migraciones SQL canónicas viven en el monorepo en `packages/storage/migrations/`. Cada archivo en ese directorio es un cambio de esquema forward-only. El servicio `migrations` en `compose.yaml` es el **único** punto de entrada que debe aplicarlas.

La distribución de Compose lee el directorio canónico de solo lectura y aplica cada archivo nuevo más su marcador en **una transacción de Postgres**:

```sh
psql "$CMS_DATABASE_URL" -v ON_ERROR_STOP=1 -c \
  'CREATE TABLE IF NOT EXISTS public.cms_schema_migrations (revision text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
for migration in /migrations/*.sql; do
  revision="$(basename "$migration")"
  if printf "%s\n" "SELECT 1 FROM public.cms_schema_migrations WHERE revision = :'revision';" \
    | psql "$CMS_DATABASE_URL" -v revision="$revision" -At | grep -q 1; then
    continue
  fi
  {
    cat "$migration"
    printf "\nINSERT INTO public.cms_schema_migrations (revision) VALUES (:'revision');\n"
  } | psql "$CMS_DATABASE_URL" -v revision="$revision" -v ON_ERROR_STOP=1 -1 -f -
done
```

`compose.yaml:105-140`. Las invariantes relevantes son:

- El script crea `public.cms_schema_migrations` (una tabla `(revision text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`) una vez, idempotentemente. La `revision` es el nombre de archivo de la migración — `0001_governance.sql`, `0002_*.sql`, y así sucesivamente.
- Para cada archivo de migración en el directorio de solo lectura, consulta el libro por la `revision` coincidente. Si la fila existe, el archivo se **omite** silenciosamente. Si la fila no existe, el script ejecuta `cat "$migration" ; INSERT INTO public.cms_schema_migrations (revision) VALUES (:'revision');` en **una sola** transacción `psql -1`.
- `psql -v ON_ERROR_STOP=1` aborta en el momento en que una sentencia SQL devuelve un error. El par completo `cat + INSERT` está envuelto en un `BEGIN ... COMMIT` mediante `psql -1`, por lo que un fallo en cualquiera de los dos lados revierte la migración **y** el INSERT del marcador juntos.
- El servicio `migrations` tiene `restart: "no"` y `read_only: true`. Es de un solo disparo. Un nuevo archivo de migración añadido al directorio no se aplica hasta que el operador reejecuta la puerta explícitamente.
- El servicio `server` declara `migrations: condition: service_completed_successfully` en su `depends_on` ([`compose.yaml:243-265`](../../compose.yaml#L243-L265)). Compose rehúsa iniciar el servidor hasta que la puerta de migración salga con 0. No hay override, no hay atajo `service_healthy`, y no hay flag documentado para saltarla.

Diagnosticar la puerta desde fuera usa la misma reejecución de la imagen con salida limpia:

```sh
docker compose run --rm migrations
```

Esto itera el mismo script e imprime las revisiones registradas. Los nombres de archivo ya registrados se omiten por la consulta al libro; el siguiente archivo sin revisión registrada es el que la puerta aplicará. Cuando el script termina sin entrar en la rama de aplicación, la puerta sale con 0 y Compose procede a iniciar el servidor.

## Migraciones SQL append-only

Tres reglas rigen el esquema:

1. **Forward-only.** Sin `DOWN`, sin `UNDO`, sin `REVERT` SQL. La recuperación de una migración corrupta o incorrecta es vía `DROP TABLE` + reaprovisionamiento desde instantánea, no vía una sentencia SQL inversa ([`packages/storage/migrations/0001_governance.sql`](../../packages/storage/migrations/0001_governance.sql#L20-L24)).
2. **Append del marcador en la misma transacción que el SQL.** `psql -1` lo hace cumplir. Un fallo en el lado SQL revierte tanto el cambio de esquema como el INSERT del marcador. Un fallo tras el SQL pero antes del INSERT del marcador es imposible porque ambos se canalizan a la misma invocación `psql -v ON_ERROR_STOP=1 -1`.
3. **Nunca alterar una migración aplicada.** Los bytes que se aplicaron son el contrato. Renombrar un archivo o editar su contenido tras el release es corrupción silenciosa: el nombre puede coincidir o no con una fila en `cms_schema_migrations`, y el esquema puede divergir del libro registrado.

La naturaleza append-only se refuerza en la capa SQL:

- `cms_storage.audit_events` rechaza `UPDATE` / `DELETE` / `TRUNCATE` mediante triggers `BEFORE` que lanzan `SQLSTATE 'P0001'` con el texto marcador `cms_storage.audit_events is append-only`. El clasificador de almacenamiento mapea tanto el SQLSTATE como el marcador a `AppendOnlyViolationError` ([`packages/storage/migrations/0001_governance.sql`](../../packages/storage/migrations/0001_governance.sql#L578-L612)).
- La capa de esquema hace cumplir las transiciones de `cms_storage.idempotency_records` desde `in_progress` a un resultado terminal (`succeeded` / `failed`) bajo un único `UPDATE`, pero la tabla misma **no** es append-only en la capa SQL. Las restricciones `CHECK` custodian la transición; los triggers `BEFORE UPDATE / DELETE` no ([`packages/storage/migrations/0001_governance.sql`](../../packages/storage/migrations/0001_governance.sql#L607-L613)).

La propiedad append-only de `audit_events` es lo que hace imposible una migración `DOWN`: eliminar la tabla destruye la línea de auditoría de la que dependen tanto el regulador como el linaje de reversión. Por eso la recuperación es por instantánea + restauración, no por SQL inversa.

## Lo que un operador puede y no puede hacer

### Operaciones permitidas

El operador puede:

- Añadir un **nuevo** archivo SQL ordenado a `packages/storage/migrations/` cuyo nombre sea léxicamente mayor que la revisión registrada más alta. Los nombres de archivo empiezan en `0001_*.sql`; la puerta ordena por nombre de archivo y aplica solo los archivos sin revisión.
- Reejecutar la puerta con `docker compose run --rm migrations` para aplicar archivos recién añadidos. El libro `cms_schema_migrations` hace segura su reinvocación.
- Capturar instantáneas de los volúmenes nombrados `cms_postgres_data` y `cms_minio_data` **antes** de promover una nueva imagen que agrupa nuevos archivos de migración ([`operate.es.md`](operate.es.md#disciplina-de-instantáneas-postgres--minio) · [English](operate.md#postgres--minio-snapshot-discipline)).
- `psql "$CMS_DATABASE_URL" -v ON_ERROR_STOP=1 -c "SELECT revision, applied_at FROM public.cms_schema_migrations ORDER BY applied_at;"` para leer qué se ha aplicado.

La invariante del operador: cada cambio de esquema es un archivo nuevo y ordenado, aplicado por la puerta, registrado en el libro, y siempre forward-only.

### Operaciones prohibidas

El operador no puede:

- **Renombrar o editar una migración aplicada.** Una vez que `cms_schema_migrations` registra un nombre de archivo, los bytes de ese archivo son parte del contrato. Editarlos después es corrupción silenciosa.
- **Escribir una migración `DOWN`.** El directorio de migraciones acepta solo archivos forward. El tiempo de ejecución nunca ejecuta una SQL inversa, y el README establece "DOWN migrations are intentionally NOT provided" ([`packages/server/migrations/README.txt`](../../packages/server/migrations/README.txt#L47-L48)).
- **`INSERT INTO public.cms_schema_migrations` manual.** El INSERT del marcador es responsabilidad de la puerta. Un INSERT manual reclama una revisión aplicada sin realmente aplicarla, y la siguiente ejecución `psql -v ON_ERROR_STOP=1` contra ese nombre omitirá silenciosamente un cambio de esquema faltante.
- **`DELETE` o `TRUNCATE cms_storage.audit_events`.** Los triggers lanzan `SQLSTATE 'P0001'`; cualquier intento aborta la transacción. No hay override `WITH (append_only = false)`, y no debe haberlo. Eliminar la tabla desde la base de datos es una decisión destructiva de recuperación de respaldo, no una operación rutinaria.
- **Saltarse la dependencia `migrations: service_completed_successfully`.** Iniciar el `server` contra un conjunto de migraciones a medio aplicar es inseguro y está explícitamente prohibido por el README ([`packages/server/migrations/README.txt`](../../packages/server/migrations/README.txt#L40-L42)). Compose rehúsa este cableado; las únicas rutas alternativas serían un fork de `compose.yaml`, que también está fuera de alcance.
- **Aplicar una migración desde un directorio distinto de `packages/storage/migrations/`.** El servicio `migrations` monta ese directorio de solo lectura en `/migrations` ([`compose.yaml:117-118`](../../compose.yaml#L117-L118)); el script itera `/migrations/*.sql`. Un directorio diferente es un contrato diferente.

Si el operador necesita un cambio de esquema, abre un pull request que añade un nuevo archivo bajo `packages/storage/migrations/`. La puerta lo aplica en la siguiente llamada a `docker compose run --rm migrations`. El cambio se revisa como parte del mismo pull request que lo introduce.

## Frontera de instantánea / restauración

La puerta de migración no posee los respaldos. Posee la **versión de esquema forward-only**. Los respaldos viven en la ruta de instantánea de volumen descrita en [`operate.es.md`](operate.es.md#disciplina-de-instantáneas-postgres--minio) · [English](operate.md#postgres--minio-snapshot-discipline).

La frontera es:

- **Paso adelante.** Añadir un archivo, ejecutar la puerta y reiniciar el `server` contra la nueva imagen. La puerta registra la nueva revisión en `cms_schema_migrations`. El par `(cms_postgres_data, cms_minio_data)` continúa hacia adelante.
- **Paso de recuperación.** Detener el stack, restaurar el volumen nombrado `cms_postgres_data` desde una instantánea tomada **antes** de la actualización fallida, restaurar `cms_minio_data` desde la instantánea coincidente, recrear `cms_schema_migrations` con las filas que cubre la instantánea y reiniciar el `server` contra la imagen previa. La puerta `migrations` ahora sale con 0 sin trabajo que hacer, porque las revisiones registradas coinciden con los archivos en disco.

Una instantánea tomada **después** de una migración fallida no repara el esquema. Una instantánea tomada **antes** de la actualización es lo único que permite al operador retroceder. Por tanto:

1. Capture instantánea antes de cualquier promoción de `cms-server:local` ([`operate.md`](operate.md) · [`.es`](operate.es.md) tabla de cadencia de instantáneas).
2. Aplique la actualización reejecutando `docker compose run --rm migrations`.
3. Arranque la nueva imagen y observe las sondas de readiness (`/health/ready`) y los registros JSON estructurados ([`operate.es.md`](operate.es.md#liveness-readiness-y-métricas) · [English](operate.md#liveness-readiness-and-metrics)).
4. Si la migración tuvo éxito pero el nuevo servidor falla, **detenga el stack, restaure la instantánea, reinicie la imagen previa**. No intente mutar `cms_schema_migrations` para "saltarse" la actualización fallida — los marcadores son el contrato.

No hay atajo `pg_dump | psql` entre versiones: el esquema y la instantánea del volumen nombrado se mueven juntos o no se mueven.

## Autoría de una nueva migración

Cuando el equipo necesita un cambio de esquema, el archivo aterriza en el mismo pull request que el cambio de tiempo de ejecución que depende de él. La estructura canónica del archivo es:

```text
NNNN_<slug_corto>.sql
```

con un bloque `-- =============================================================================` al inicio que:

- Nombra el número de migración y el slug.
- Establece el **alcance** del cambio: qué tablas / índices / triggers / funciones se tocan, y cuáles no se tocan intencionalmente.
- Establece las **notas de idempotencia**: forward-only, marcador anexado, bytes inmutables una vez aplicados.
- Establece cualquier **justificación de reversión** — es decir, por qué el cambio no proporciona una SQL `DOWN` y cómo se ve la ruta de instantánea + restauración para el mismo.
- Usa manejo portable de `pgcrypto`: `gen_random_uuid()` está en `pgcrypto` en PG < 13 y nativo en PG ≥ 13, por lo que la llamada `CREATE EXTENSION` se envuelve en `DO / EXCEPTION WHEN OTHERS THEN NULL` ([`packages/storage/migrations/0001_governance.sql`](../../packages/storage/migrations/0001_governance.sql#L67-L78)).

Dentro del archivo, cada fila con ámbito de tenant lleva una columna `tenant_id`. Cada `UPDATE` sobre una tabla gobernada usa `version BIGINT NOT NULL DEFAULT 1` para concurrencia optimista. Cada política de `BEFORE INSERT / UPDATE` vive en TypeScript para que una única fuente de verdad aplique, no duplicada en triggers SQL. La propiedad append-only de `cms_storage.audit_events` es la **única** invariante a nivel de tabla forzada en la capa SQL; todo lo demás es política en `@cms/core` y `@cms/storage`.

## Qué se verificó

El contrato de la puerta de migración — el libro `cms_schema_migrations`, la invocación `psql -v ON_ERROR_STOP=1 -1`, la dependencia `service_completed_successfully` y el montaje de solo lectura — se lee desde los archivos fuente citados arriba. `docker compose -f compose.yaml config --quiet` fue el único comando relacionado con Docker que V1 ejecutó; validó solo la sustitución, no un daemon en vivo. Un `docker compose run --rm migrations`, `docker compose up -d server` o `docker compose pull` en vivo **no** forman parte de V1 y no se afirman en esta página. Para orientación de despliegue, sigue [`self-host.es.md`](self-host.es.md) · [English](self-host.md) y [`../security/hardening.es.md`](../security/hardening.es.md) · [English](../security/hardening.md). La evidencia en disco se limita a los archivos fuente citados y al informe de siete comandos referenciado desde [`quickstart.es.md`](quickstart.es.md) · [English](quickstart.md).

## Dónde continuar

- Operaciones de día 2: [`operate.md`](operate.md) · [`.es`](operate.es.md).
- Puesta en marcha: [`self-host.md`](self-host.md) · [`.es`](self-host.es.md).
- Cada valor `CMS_*` y su regla de análisis: [`configure.md`](configure.md) · [`.es`](configure.es.md).
- La secuencia de verificación del monorepo de siete comandos: [`quickstart.md`](quickstart.md) · [`.es`](quickstart.es.md).
- La arquitectura del stack de alojamiento (justificación de red y almacenamiento): [`../concepts/architecture.md`](../concepts/architecture.md) · [`.es`](../concepts/architecture.es.md).
- La frontera de contenido y el modelo de autoridad humana: [`../concepts/content-boundary.md`](../concepts/content-boundary.md) · [`.es`](../concepts/content-boundary.es.md).
- El informe de verificación: `artifacts/g008/workspace-test-report.json`.
- Migraciones SQL canónicas: [`packages/storage/migrations/`](../../packages/storage/migrations/).
- Nota del operador: [`packages/server/migrations/README.txt`](../../packages/server/migrations/README.txt).
- Servicio `migrations` en compose: [`compose.yaml:102-140`](../../compose.yaml#L102-L140).
- Dependencia de migración del servidor: [`compose.yaml:243-265`](../../compose.yaml#L243-L265).
- Triggers append-only: [`packages/storage/migrations/0001_governance.sql:578-612`](../../packages/storage/migrations/0001_governance.sql#L578-L612).
