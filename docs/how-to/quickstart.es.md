# Inicio rápido

> [English version](quickstart.md) · El inglés y el español son locales pares. Ambos archivos se publican en el mismo pull request (regla de cero desfase). Véase [`../README.md#same-pr-enes-zero-lag`](../README.md#same-pr-enes-zero-lag).

Esta página contiene la secuencia de siete comandos de verificación para operadores registrada en `artifacts/g008/workspace-test-report.json` el `2026-07-27T21:18:49.543Z`. Los siete comandos verificados se reproducen sin adiciones ni omisiones; el prerrequisito obligatorio y no verificado de instalación se documenta por separado más abajo.

## Prerrequisitos

El arranque asume un único host con el siguiente toolchain fijado por el manifiesto del monorepo:

- **Node.js ≥ 22.0.0.** Fijado en `package.json` bajo `engines.node`. La imagen Docker fija `NODE_VERSION=22.20.0` (ARG en `Dockerfile`).
- **pnpm ≥ 9.0.0.** Fijado en `package.json` bajo `engines.pnpm`. La imagen Docker fija `PNPM_VERSION=9.15.0` (ARG en `Dockerfile`). La declaración del gestor de paquetes es `packageManager: pnpm@9.15.0`.

El lockfile (`pnpm-lock.yaml`) es la fuente de verdad para el grafo de dependencias del monorepo. `pnpm install` es obligatorio para materializar el monorepo antes de ejecutar los comandos de verificación; es un paso de preparación obligatorio **no** incluido en los siete comandos verificados de abajo. El informe de evidencia asume una única install al inicio y no vuelve a ejecutar install entre los comandos.

## Entorno

El monorepo publica un placeholder `.env.example` en la raíz del proyecto. Cópielo a `.env` y reemplace solo los valores placeholder — nunca incorpore un secreto real a un archivo versionado:

```text
CMS_POSTGRES_PASSWORD=replace-with-a-strong-database-password
CMS_MINIO_ROOT_PASSWORD=replace-with-a-strong-minio-root-password
CMS_OBJECT_SECRET_ACCESS_KEY=replace-with-a-distinct-strong-application-secret
```

Trate `.env.example` como el inventario completo y autoritativo de variables. Sustituya cada marcador `replace-with-*`, incluida la contraseña incorporada en `CMS_DATABASE_URL`; mantenga separadas las credenciales raíz y de aplicación de MinIO. No deduzca las variables obligatorias a partir de este inicio rápido. La configuración del servidor falla de forma cerrada cuando faltan valores `CMS_*` obligatorios o tienen un formato inválido.

## Los siete comandos verificados

Los siete comandos siguientes son el conjunto literal del informe de verificación de V1. Ejecútelos en orden desde la raíz del proyecto. Son comandos de verificación deterministas y seguros para volver a ejecutar.

1. **Verificación de tipos de TypeScript en el monorepo.**

   ```sh
   pnpm typecheck
   ```

   Alcance verificado: 13 proyectos de paquete.

2. **Pruebas unitarias en el monorepo.**

   ```sh
   pnpm test
   ```

   Alcance verificado: 27 archivos de prueba, 899 pruebas.

3. **Compilación del monorepo.**

   ```sh
   pnpm build
   ```

   Alcance verificado: 13 proyectos de paquete.

4. **Guardia de licencias.** El guardia de la lista permitida Apache-2.0 escanea el monorepo y rechaza publicar una release que viole la frontera de licencias del núcleo abierto.

   ```sh
   node packages/licensing-guard/dist/index.js --root . --json
   ```

   Alcance verificado: 14 paquetes, 0 hallazgos. El guardia admite la excepción documentada MPL-2.0 solo para desarrollo de la herramienta de pruebas `axe-core`; el grafo de artefactos de ejecución no incluye la excepción.

5. **Recorrido de extremo a extremo en navegador.**

   ```sh
   pnpm test:e2e
   ```

   Alcance verificado: 6 proyectos (escritorio/tableta/móvil Chromium × en/es), 0 infracciones de axe, veredictos `CLEAN` de Tastecheck. Los artefactos del navegador se escriben en `artifacts/g008/{desktop,tablet,mobile}/handoff-beat-{en,es}.{json,png}`.

6. **Validación de la configuración de Compose.**

   ```sh
   docker compose -f compose.yaml config --quiet
   ```

   Este paso valida la interpolación de Compose y no requiere un daemon Docker en ejecución. La corrida verificada usó sustituciones únicamente de validación, no secretas. Una compilación/ejecución en vivo respaldada por un daemon Docker **no** forma parte de la verificación de V1 — véase la sección de limitaciones más abajo.

7. **Verificación de sintaxis del script de healthcheck de autoalojamiento.**

   ```sh
   node --check scripts/self-host-healthcheck.mjs
   ```

   El propio healthcheck se invoca desde el contenedor `server` en ejecución; este comando solo verifica que el script se analiza.

## Evidencia verificada

El informe verificado en `artifacts/g008/workspace-test-report.json` registra los siete comandos de forma literal, la marca de tiempo verificada y las limitaciones de V1. Los archivos de evidencia del navegador en `artifacts/g008/{desktop,tablet,mobile}/` registran el árbol de accesibilidad por locale, los resultados de axe, los veredictos de Tastecheck y las capturas de pantalla de página completa.

## Limitaciones

La verificación de V1 es honesta sobre lo que no hizo:

- **Sin compilación ni ejecución respaldada por un daemon Docker.** La configuración de Compose se validó solo con interpolación; la imagen del contenedor no se compiló y el servidor no se ejecutó dentro de Docker. Las pruebas de paquetes en ejecución y la verificación de sintaxis del healthcheck cubren la capa de aplicación, no la capa de contenedor.
- **Sin validación externa con participantes neurodivergentes.** El producto se describe en el catálogo de i18n como "neurodivergent-accessible by design". La validación externa es un objetivo de v1.1 y no está en V1.
- **Sin un segundo adaptador independiente.** Un segundo adaptador es la puerta de validación de contrato de v1.1, no un reclamo de cierre de V1.

## Dónde continuar

- Páginas de conceptos: [`../concepts/architecture.md`](../concepts/architecture.md) · [`.es`](../concepts/architecture.es.md), [`../concepts/governance-and-human-authority.md`](../concepts/governance-and-human-authority.md) · [`.es`](../concepts/governance-and-human-authority.es.md), [`../concepts/handoff-beat.md`](../concepts/handoff-beat.md).
- Guía de autoría: [`authoring.md`](authoring.md) · [`.es`](authoring.es.md).
- Declaración de accesibilidad: [`../accessibility/statement.md`](../accessibility/statement.md) · [`.es`](../accessibility/statement.es.md).
- Glosario: [`../project/glossary.md`](../project/glossary.md) · [`.es`](../project/glossary.es.md).
- Informe de verificación: `artifacts/g008/workspace-test-report.json`.
