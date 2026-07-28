# Handoff Beat

Handoff Beat es el recorrido de autoría no técnica para preparar un cambio gobernado en el sitio anfitrión. Es una superficie de autor bilingüe y acotada: una persona autora inicia sesión mediante OIDC, edita un borrador, comprueba una vista previa y propone el borrador para revisión humana. El repositorio anfitrión sigue siendo la fuente canónica; Handoff CMS registra la propuesta y coordina la entrega gobernada. El cliente de autoría no se convierte en una segunda fuente de verdad.

Esta página describe el recorrido de autoría, no una vista general genérica, un catálogo de referencia de API ni un manual de operaciones.

## Qué hace la superficie de autoría

- **Inicio de sesión:** el acceso usa el emisor OIDC configurado por el anfitrión. El servidor verifica emisor, audiencia, firma JWKS, expiración, tiempo `not-before` y algoritmo permitido antes de que la solicitud llegue a la API de autoridad ([configuración OIDC](../../packages/server/src/config.ts#L82-L102), [autenticación y resolución de identidad](../../packages/api/src/auth.ts#L1-L18)).
- **Edición y preparación:** edita texto y campos de registros estructurados en inglés y español, edita el título y el resumen seguros de un producto, actualiza texto alternativo/recorte/punto focal de imágenes y usa las acciones de bloques aprobadas que expone la superficie de autoría. Son operaciones locales de borrador hasta que se envía una propuesta ([modelo de autoría](../../packages/web/src/model.ts#L11-L45)).
- **Vista previa:** solicita a la API una vista previa renderizada por el servidor del snapshot actual. Devuelve una URL de vista previa y un token de revisión; no escribe en la fuente canónica ([`AuthoringApi.previewFromSnapshot`](../../packages/web/src/model.ts#L380-L400)).
- **Propuesta:** envía el snapshot bilingüe como propuesta. Una propuesta es una intención junto con una revisión candidata; se envía a revisión humana y no se aprueba ni se publica por sí sola ([`propose`](../../packages/web/src/model.ts#L392-L400), [manejador de acciones de la interfaz](../../packages/web/src/app.ts#L605-L629)).

## Lo que la persona autora no puede hacer

La persona autora solo puede previsualizar y proponer. **No debe aprobar, publicar, aplicar, reconciliar ni revertir un cambio.** Son operaciones de autoridad gobernadas, fuera de las capacidades de autoría. La aprobación humana es una decisión separada que comprueban la capa de autoridad y la política central; las identidades de servicio y MCP son rechazadas para aprobar, publicar y revertir ([rechazo de autoridad](../../packages/api/src/auth.ts#L197-L225), [reglas de política](../../packages/core/src/policy.ts#L1-L20)). La confirmación de propuesta dice explícitamente que proponer no aprueba ni publica ([catálogo en español](../../packages/i18n/src/index.ts#L248-L264)).
Cada cambio aplicado o publicado requiere una decisión separada de aprobación humana; proponer nunca equivale a aprobar por implicación.

La superficie puede mostrar estados de propuesta, despliegue, auditoría o reversión para que una persona no técnica entienda lo ocurrido. Mostrar un estado no concede permiso para ejecutar la operación gobernada. Un control desactivado, un diálogo de confirmación o un estado mostrado no son una invitación a eludir el flujo humano: la API sigue siendo la autoridad.

El comercio tiene un límite intencionado. El título y el resumen del producto son campos de contenido seguros; el precio y los campos comerciales se muestran como solo lectura. El navegador no tiene entrada de precio, y los cambios comerciales siguen sujetos a coordinación y son de solo lectura para el cliente ([renderizado de producto](../../packages/web/src/template.ts#L302-L329), [aserción del navegador](../../packages/web/e2e/handoff-beat.spec.ts#L58-L65)). Solicita un cambio comercial a la persona coordinadora de comercio; no intentes incluirlo en una propuesta de autoría.

## Ciclo de vida: los beats de una propuesta

El ciclo visible de autoría se corresponde con la máquina de estados gobernada:

1. **`editing`** — se prepara un borrador bilingüe con cambios locales. El anfitrión aún es la fuente canónica.
2. **`preview_ready`** — el snapshot actual pasó las comprobaciones de autoría y se generó una vista previa. Es un artefacto de revisión, no una escritura.
3. **`proposed`** — la persona autora envió la revisión candidata a revisión humana. El deshacer local ya no es el mecanismo para cambiar esa propuesta confirmada.
4. **`approved`** — una persona humana autorizada registró la aprobación. La persona autora no realiza esta transición.
5. **`canonical_written`** — una escritura gobernada llegó al repositorio canónico del anfitrión. Esto es distinto de que el sitio esté en vivo.
6. **`deploy_pending`** — el anfitrión o coordinador de despliegue todavía no ha informado de la propagación completa.
7. **`live`** — el recibo de despliegue informa de que la versión resultante está en vivo.

La API y la máquina de estados central mantienen separadas las bytes canónicas y la propagación ([contrato de la API](../../packages/api/src/index.ts#L17-L27), [máquina de estados](../../packages/core/src/state-machine.ts#L1-L21)). Una reversión gobernada es una única acción compensatoria humana: su límite de escritura del adaptador/despliegue termina en **`canonical_written`**, nunca en `live`; por separado, el ciclo de vida de la propuesta gobernada transita al estado terminal **`rolled_back`** y se audita como `proposal.rolled_back`. La reconciliación asíncrona del despliegue sigue la escritura canónica. Eso es distinto del **deshacer local**, que revierte una edición no enviada en el navegador. Usa el deshacer local mientras editas y solicita a la persona humana/operadora responsable una reversión gobernada cuando una propuesta o un despliegue necesite revertirse. Un runtime de Docker no queda establecido por este recorrido de autoría; no infieras un despliegue vivo en contenedor a partir de la vista previa o la superficie del navegador.

## Inglés y español son pares

Cada propuesta de autoría lleva los dos idiomas pares. Inglés y español no son un idioma principal con fallback opcional: se rechazan los valores ausentes y el traductor falla de forma cerrada cuando falta una clave ([contrato de idiomas pares](../../packages/i18n/src/index.ts#L1-L12), [campos bilingües obligatorios](../../packages/web/src/model.ts#L28-L35)). Completa y revisa los valores en inglés y español juntos. Cambiar el idioma cambia el idioma de presentación; no elimina el contenido obligatorio del otro par. El recorrido de cinco tareas del navegador completa ambos textos y ambos textos alternativos antes de la vista previa ([recorrido EN/ES](../../packages/web/e2e/handoff-beat.spec.ts#L25-L56)).

## La accesibilidad forma parte del diseño

V1 es **«accesible para personas neurodivergentes por diseño»**. Es una postura de diseño, no una afirmación de validación externa. La limitación actual es: **«La validación externa está prevista para la v1.1.»** ([redacción del catálogo](../../packages/i18n/src/index.ts#L305-L319), [evidencia del navegador](../../packages/web/e2e/handoff-beat.spec.ts#L131-L145)).
El runtime de Docker no está verificado por este recorrido de documentación; no afirmes un despliegue vivo de Docker basándote solo en el navegador o en la evidencia de Compose.

La superficie usa landmarks semánticos nativos y controles reales con etiquetas, mantiene simétricas las superficies inglesa y española, permite el desplazamiento mediante teclado, restaura el foco después de los comandos, lleva el foco al resumen de errores cuando una acción se bloquea y anuncia éxitos/errores mediante regiones activas ([contrato del renderizador](../../packages/web/src/template.ts#L1-L27), [contrato de accesibilidad de la capa de eventos](../../packages/web/src/app.ts#L5-L24)). Las preferencias de baja distracción y movimiento reducido son preferencias explícitas, y el navegador comprueba la navegación por teclado además de un análisis axe sin infracciones ([recorrido de accesibilidad](../../packages/web/e2e/handoff-beat.spec.ts#L89-L99), [implementación de preferencias](../../packages/web/src/app.ts#L207-L218)). Estas ayudas reducen la carga cognitiva y sensorial; no cambian la autoridad de gobernanza.

## Cuando algo falla

El fallo visible para la persona autora debe ser concreto y recuperable:

- Un valor obligatorio en inglés o español que falte bloquea la vista previa e identifica el campo en un resumen de errores; el foco pasa a ese resumen ([recorrido del fallo](../../packages/web/e2e/handoff-beat.spec.ts#L191-L199)).
- Una edición local se puede deshacer mientras está en la capa de ediciones pendientes. Después de proponer, la reversión es gobernada, no un deshacer local ([contrato de edición local](../../packages/web/src/model.ts#L292-L305)).
- Los fallos de la API se registran como una entrada de error de auditoría y se muestran como estado de error; el cliente no simula éxito ni hace fallback silencioso a otra fuente ([contrato de errores](../../packages/web/src/model.ts#L42-L46), [mapeo cerrado de errores](../../packages/web/src/model.ts#L733-L747)).
- Para el vocabulario estable de errores del cliente, consulta [`STORE_ERROR_CODES`](../../packages/web/src/model.ts#L111-L133). Códigos como `E_MISSING_ALT`, `E_NOT_PREVIEW_READY`, `E_API_ERROR` y `E_NOT_REVERSIBLE` describen condiciones visibles distintas; no los sustituyas por un fallback inventado.

## Fuentes

- [Arquitectura y límite de fuente canónica](architecture.es.md)
- [Recorrido de Handoff Beat en el navegador](../../packages/web/e2e/handoff-beat.spec.ts)
- [Fixture y seam de API de autoría](../../packages/web/e2e/handoff-beat.ts)
- [Renderizador de autoría](../../packages/web/src/template.ts)
- [Capa de eventos de autoría](../../packages/web/src/app.ts)
- [Modelo de autoría](../../packages/web/src/model.ts)
