# Autoría en Handoff Beat

Usa esta guía si eres una persona autora no técnica, autenticada mediante OIDC, que prepara un cambio bilingüe. La superficie de autoría sirve para **editar → previsualizar → proponer**. Una persona humana con la autoridad gobernada separada revisa y decide qué se puede aprobar, aplicar, publicar o revertir.

## 1. Inicia sesión

Abre la superficie de autoría de Handoff e inicia sesión mediante el proveedor OIDC configurado. El servidor verifica emisor OIDC, audiencia, firma JWKS, expiración, `not-before` y algoritmo permitido; el cliente no puede sustituir esas comprobaciones ([contrato OIDC del servidor](../../packages/server/src/config.ts#L82-L102), [resolución de identidad](../../packages/api/src/auth.ts#L1-L18)). Usa la identidad y el tenant que proporciona tu anfitrión. No pegues credenciales en una propuesta, campo del navegador ni documento.

Después de iniciar sesión, confirma que la página de autoría expone los dos pares **inglés** y **español**. El selector de idioma cambia el idioma de la interfaz y conserva el mismo conjunto de superficies; no es un mecanismo de fallback ([renderizador de idioma](../../packages/web/src/template.ts#L8-L27)).

## 2. Prepara la propuesta bilingüe

1. Escribe o revisa el valor en inglés.
2. Escribe o revisa el valor en español para el mismo campo.
3. En bloques de imagen, proporciona texto alternativo obligatorio en ambos idiomas y, cuando haga falta, define recorte y punto focal.
4. En contenido seguro de producto, edita solo el título y el resumen. Consulta el precio mostrado como contexto, pero no lo edites.
5. Usa solo las acciones de bloque que expone la superficie para la sección aprobada (por ejemplo, mover, ocultar o duplicar).

Inglés y español son contenido par, no contenido principal más una traducción opcional. Los valores ausentes se rechazan en vez de copiarse silenciosamente desde el otro idioma ([regla de idiomas pares del modelo](../../packages/web/src/model.ts#L28-L35)). El recorrido del navegador demuestra cómo completar ambos textos y textos alternativos, y cómo actualizar títulos de producto seguros mientras comprueba que no existe una entrada de precio ([recorrido de cinco tareas](../../packages/web/e2e/handoff-beat.spec.ts#L37-L65)).

**Límite comercial:** el precio, el inventario, los datos acoplados a Stripe y los demás campos comerciales están sujetos a coordinación y son de solo lectura para el cliente. No añadas ni intentes cambiar esos valores en una propuesta de autoría. Contacta con la persona coordinadora de comercio mediante el proceso establecido por tu anfitrión.

Mientras sigues editando, **Deshacer la última edición local** puede revertir un cambio local pendiente. Es historial local del navegador; no es una reversión gobernada ni escribe contenido canónico ([contrato de deshacer local](../../packages/web/src/model.ts#L292-L305), [control del historial](../../packages/web/src/template.ts#L465-L495)).

## 3. Previsualiza

Elige **Vista previa** cuando ambos idiomas y el texto alternativo obligatorio de las imágenes estén completos. El cliente valida el snapshot actual y solicita a la API una vista previa renderizada por el servidor. Una respuesta correcta crea el estado `preview_ready` y un token de revisión de vista previa; no aplica, publica ni escribe en el repositorio anfitrión ([seam de la API de vista previa](../../packages/web/src/model.ts#L384-L390), [envío de vista previa](../../packages/web/src/model.ts#L1410-L1459)). Revisa en la vista previa ambos idiomas y la información comercial segura mostrada.

Si la vista previa se bloquea, lee el resumen de errores en vez de adivinar. Un campo obligatorio ausente identifica el campo y lleva el foco al resumen; corrige el valor indicado en inglés o español y vuelve a previsualizar ([prueba del fallo](../../packages/web/e2e/handoff-beat.spec.ts#L191-L199)). Los códigos estables de error del cliente están en [`STORE_ERROR_CODES`](../../packages/web/src/model.ts#L111-L133), incluidos `E_MISSING_ALT`, `E_NOT_PREVIEW_READY`, `E_API_ERROR` y `E_NOT_REVERSIBLE`.

## 4. Solicita revisión humana

Cuando la vista previa sea correcta, elige **Proponer para revisión** y confirma la solicitud. Esto envía el snapshot bilingüe como propuesta y crea una revisión candidata. No aprueba ni publica el cambio; la confirmación localizada expresa directamente esa diferencia ([etiquetas y confirmación de propuesta](../../packages/i18n/src/index.ts#L248-L264), [envío de propuesta](../../packages/web/src/model.ts#L1460-L1500)). Comparte el contexto de la propuesta/revisión con la persona revisora humana mediante el canal normal de revisión de tu anfitrión.

Después de proponer, la capa de ediciones pendientes locales queda confirmada. No uses el deshacer local como sustituto de una corrección gobernada; prepara una nueva propuesta o pregunta a la persona revisora/coordinadora qué corrección se necesita.

## 5. Conoce el límite de autoría

La superficie de autoría no debe usarse para **aprobar, publicar, aplicar, reconciliar ni revertir**. No intentes llamar esas acciones desde la consola del navegador, un script que solo actúe en el cliente, una credencial de servicio ni una ruta MCP. La aprobación, publicación, escritura canónica, reconciliación de despliegue y reversión gobernada requieren el flujo de autoridad separado y comprobaciones humanas ([reglas de la API de autoridad](../../packages/api/src/index.ts#L17-L27), [exigencia de persona humana](../../packages/api/src/auth.ts#L197-L225)).

Un estado mostrado como `approved`, `canonical_written`, `deploy_pending` o `live` es información, no una capacidad de autoría. Si hace falta revertir, solicita ayuda a la persona humana/operadora autorizada. En este contrato, la reversión termina en `canonical_written`; después sigue la reconciliación asíncrona del despliegue. Esto es deliberadamente distinto de deshacer una edición local no enviada.

## 6. Usa los controles accesibles

Handoff Beat es **«accesible para personas neurodivergentes por diseño»**. Esta es la redacción exacta de V1; no equivale a validación externa. La limitación actual es **«La validación externa está prevista para la v1.1.»** ([redacción del catálogo](../../packages/i18n/src/index.ts#L305-L319)).
El runtime de Docker no está verificado; este recorrido de autoría y su vista previa no establecen un despliegue vivo en contenedor.

Usa el enlace para saltar al contenido, los controles nativos etiquetados, la navegación por teclado, los indicadores de foco visible y las preferencias de baja distracción o movimiento reducido cuando te resulten útiles. Cuando una acción funciona, un anuncio de estado lo confirma. Cuando falla, una región de error asertiva y el foco en el resumen indican dónde continuar; la aplicación no finge silenciosamente que el comando funcionó ([comportamiento accesible de la aplicación](../../packages/web/src/app.ts#L14-L24), [comprobaciones de accesibilidad E2E](../../packages/web/e2e/handoff-beat.spec.ts#L89-L99)).

Las superficies EN y ES son pares: las mismas regiones de autoría permanecen presentes en cada idioma, y las traducciones ausentes fallan de forma cerrada en lugar de usar fallback al inglés ([contrato de idiomas pares](../../packages/i18n/src/index.ts#L1-L12)).

## Lista rápida de límites

- [ ] Inicié sesión mediante el proveedor de identidad OIDC configurado.
- [ ] Completé los valores en inglés y español.
- [ ] Proporcioné ambos textos alternativos cuando una imagen los requiere.
- [ ] Cambié solo contenido seguro; los campos comerciales siguen siendo de solo lectura y sujetos a coordinación.
- [ ] Revisé la vista previa renderizada por el servidor.
- [ ] Propuse el borrador para revisión humana.
- [ ] **No** aprobé, publiqué, apliqué, reconcilié ni revertí.
