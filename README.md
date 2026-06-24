# better-mcp 🚀

> **El puente definitivo entre agentes de IA y tu proyecto.**

better-mcp es un **MCP server universal** que cualquier agente (Hermes, Claude Code, Cursor, Copilot, Cline, cualquier cliente MCP) puede usar para interactuar con tu proyecto como un desarrollador humano, pero más rápido y sin fricción.

```bash
# Una vez instalado, cualquier agente conectado puede:
npx better-mcp run         # Arrancar el server MCP
# → tools: fs_read, fs_write, db_query, shell_run, git_status, project_info...
```

---

## ¿Por qué better-mcp?

Hoy, los agentes de IA interactúan con proyectos de formas **ad-hoc y frágiles**:

```
❌ "ssh a este server, haz docker compose exec db psql, corre esta query"
❌ "escribe el archivo, pero hazlo via heredoc SSH y espera que no se corrompa"
❌ "tsc pasa? no sé, pregúntale al usuario"
❌ "¿cuál era el estado del proyecto? lee 5 archivos y adivina"
```

**Con better-mcp**, el agente solo pregunta:

```
✅ fs_read("src/app/page.tsx")
✅ db_query("SELECT count(*) FROM orders")
✅ shell_run("tsc")
✅ git_status()
✅ project_info()
```

Un solo punto de entrada. Estructurado. Ejecutable. Sin ambigüedad.

---

## ¿Qué problema resuelve?

| Problema | Sin better-mcp | Con better-mcp |
|---|---|---|
| **Escribir código** | heredoc SSH corrompe strings con quotes/backticks/`${}` | `fs_write(path, content)` — escaping correcto automático |
| **Consultar DB** | Saber URL, usuario, contraseña, wrapper docker | `db_query("SELECT...")` — SQL read-only, conexión gestionada |
| **Correr tests/build** | `ssh → cd /repo → npx tsc...` (comandos exactos que el agente adivina) | `shell_run("tsc")` — comandos definidos en config |
| **Saber estado** | Preguntar al usuario o hacer 5 comandos separados | `project_info()` + `git_status()` = contexto completo en 2 calls |
| **Deploy** | Script manual, pasos olvidados, migraciones en orden incorrecto | `shell_run("deploy")` — secuencia definida, autorizable |
| **Contexto inicial** | Leer 10 archivos para entender el proyecto | `read_resource("handoff")` + `project_info()` = onboarding instantáneo |
| **Multi-agente** | Cada agente aprende los comandos por separado | Misma interfaz MCP para todos |
| **Seguridad** | Gates de permisos bloquean comandos válidos | El MCP es el único canal autorizado, control granular |

---

## Quick start

### 1. Agrega un `better-mcp.json` a tu proyecto

```json
{
  "project": "mi-app",
  "root": "/path/to/project",
  "stack": ["nextjs", "prisma", "postgres", "docker"],
  "tools": {
    "fs": { "allowedPaths": ["/path/to/project"] },
    "db": {
      "url": "${DATABASE_URL}",
      "readOnly": true
    },
    "git": { "enabled": true },
    "shell": {
      "commands": {
        "tsc": "npx tsc --noEmit",
        "build": "docker compose build",
        "test": "pnpm test",
        "lint": "pnpm lint",
        "deploy": "./scripts/deploy.sh"
      }
    }
  },
  "resources": {
    "handoff": "HANDOFF.md",
    "docs": "docs/",
    "schema": "prisma/schema.prisma"
  }
}
```

### 2. Conéctalo desde cualquier cliente MCP

**Hermes Agent** (`~/.hermes/config.yaml`):
```yaml
mcp:
  servers:
    mi-proyecto:
      command: npx
      args: ["@erquier/better-mcp", "run"]
      env:
        DATABASE_URL: "postgresql://..."
```

**Claude Desktop** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "mi-proyecto": {
      "command": "npx",
      "args": ["@erquier/better-mcp", "run"]
    }
  }
}
```

**Cursor / Cline / Cualquier cliente MCP**: mismo patrón.

### 3. Usa las tools desde cualquier agente

```
▶ fs_read("src/app/page.tsx")
▶ shell_run("tsc")
▶ db_query("SELECT id, name FROM products LIMIT 5")
▶ git_status()
```

---

## Tools disponibles

### 📁 Filesystem (`fs_*`)

| Tool | Args | Descripción |
|---|---|---|
| `fs_read(path)` | `path` | Lee archivo con paginación automática |
| `fs_write(path, content)` | `path`, `content` | Escribe archivo (escaping correcto) |
| `fs_search(pattern)` | `pattern` | Grep regex en el proyecto |
| `fs_list(path)` | `path` | Lista directorio |
| `fs_delete(path)` | `path` | Elimina archivo (con confirmación) |

### 🗄️ Database (`db_*`)

| Tool | Args | Descripción |
|---|---|---|
| `db_query(sql)` | `sql` | SQL read-only, resultados paginados |
| `db_schema()` | — | Schema completo: tablas, columnas, tipos, relaciones, índices |
| `db_explain(sql)` | `sql` | Plan de ejecución de la query |

### 🖥️ Shell (`shell_*`)

| Tool | Args | Descripción |
|---|---|---|
| `shell_run(cmd)` | `cmd` key | Ejecuta comando definido en config (build, test, deploy...) |
| `shell_raw(command, timeout?)` | `command` | Ejecuta comando shell arbitrario (restringible) |

### 🔗 Git (`git_*`)

| Tool | Args | Descripción |
|---|---|---|
| `git_status()` | — | Branch, cambios staged/unstaged, último commit |
| `git_log(limit?)` | `limit` | Historial de commits |
| `git_diff(target?)` | `target` | Diff de cambios o contra referencia |

### ℹ️ Project (`project_*`)

| Tool | Args | Descripción |
|---|---|---|
| `project_info()` | — | Stack, estructura de directorios, dependencias, config |
| `read_resource(name)` | `name` | Lee recurso del proyecto (handoff, plan, doc) |

---

## Instalación

### npm (recomendado)
```bash
npm install -g @erquier/better-mcp
# o
npx @erquier/better-mcp run
```

### Docker
```bash
docker pull ghcr.io/erquier/better-mcp
docker run -v $(pwd):/project -p 3100:3100 ghcr.io/erquier/better-mcp
```

### Python (futuro)
```bash
pip install better-mcp
```

---

## Configuración completa

El archivo `better-mcp.json` puede ir en la raíz del proyecto o pasarse con `--config path/to/better-mcp.json`.

### Schema completo

```json
{
  "$schema": "https://raw.githubusercontent.com/erquier/better-mcp/main/schema.json",
  "project": "nombre-del-proyecto",
  "root": "/ruta/absoluta",
  "name": "Nombre para mostrar",
  "description": "Descripción breve",
  "stack": ["nextjs", "prisma", "postgres"],
  "tools": {
    "fs": {
      "allowedPaths": ["/ruta/permitida"],
      "maxFileSize": 1048576
    },
    "db": {
      "url": "${DATABASE_URL}",
      "readOnly": true,
      "schemas": ["public"],
      "maxRows": 500
    },
    "shell": {
      "commands": {
        "build": "docker compose build",
        "test": "pnpm test"
      },
      "allowRaw": false
    },
    "git": {
      "enabled": true,
      "maxCommits": 50
    }
  },
  "resources": {
    "handoff": "HANDOFF.md",
    "plans": "docs/plans/",
    "schema": "prisma/schema.prisma"
  },
  "auth": {
    "mode": "none"
  }
}
```

### Variables de entorno

El config soporta `${VAR_NAME}` que se resuelven del entorno en tiempo de ejecución. Útil para credenciales de DB, tokens, etc.

---

## Casos de uso

### 🏪 Para Cuadre POS

```json
{
  "project": "cuadre",
  "root": "/opt/entretrespos",
  "tools": {
    "fs": { "allowedPaths": ["/opt/entretrespos"] },
    "db": { "url": "${DATABASE_URL}", "readOnly": true },
    "shell": {
      "commands": {
        "tsc": "npx tsc --noEmit",
        "build": "docker compose build app",
        "test:e2e": "pnpm test:e2e",
        "migrate-status": "pnpm prisma migrate status",
        "deploy": "git pull --ff-only && docker compose build app && docker compose run --rm -T --no-deps app pnpm prisma migrate deploy < /dev/null && docker compose up -d"
      }
    }
  },
  "resources": {
    "handoff": "CUADRE-HANDOFF.md"
  }
}
```

### 🏗️ Para cualquier proyecto

- Web app (Next.js, React, Vue, Angular)
- API (Express, FastAPI, Django)
- Scripts y herramientas CLI
- Proyectos con Docker Compose
- Monorepos

---

## Arquitectura

```
┌─────────────────┐     MCP protocol     ┌──────────────────────┐
│ Hermes Agent    │◄───────────────────►│                      │
│ Claude Code     │                      │   better-mcp server   │
│ Cursor          │                      │   (stdio / HTTP)     │
│ Cline           │                      │                      │
│ Cualquier       │                      ├──────────────────────┤
│ cliente MCP     │                      │                      │
└─────────────────┘                      │  Tools:              │
                                          │  ├─ fs_read         │
                                          │  ├─ fs_write        │
                                          │  ├─ db_query        │
                                          │  ├─ shell_run       │
                                          │  ├─ git_status      │
                                          │  └─ project_info    │
                                          │                      │
                                          │  Config:             │
                                          │  └─ better-mcp.json  │
                                          │                      │
                                          └──────────┬───────────┘
                                                     │
                                     ┌───────────────┴───────────────┐
                                     │  Filesystem  │  Database     │
                                     │  (read/write)│  (SQL RO)     │
                                     ├──────────────┼──────────────┤
                                     │  Shell       │  Git          │
                                     │  (build/test) │  (status/log)│
                                     └──────────────┴──────────────┘
```

El server corre como proceso stdio (o HTTP) y expone tools MCP estándar. Cada tool opera sobre el proyecto usando la configuración provista. No necesita permisos especiales más allá del acceso que tenga el usuario que lo ejecuta.

---

## Seguridad

| Mecanismo | Descripción |
|---|---|
| **Read-only DB** | `db_query` solo ejecuta SELECT, por defecto |
| **Comandos whitelist** | `shell_run` solo ejecuta comandos definidos en config |
| **Paths restringidos** | `fs_*` solo opera dentro de `allowedPaths` |
| **Sin red** | Sin conexiones externas (excepto la DB configurada) |
| **Sin dependencias externas** | Solo el SDK MCP oficial |

Para ambientes más restrictivos, se puede deshabilitar `shell_raw`, limitar `db_query` a schemas específicos, o agregar un gate de autorización antes de writes.

---

## Roadmap

### MVP (v0.1)
- [x] Config `better-mcp.json`
- [ ] Server MCP base (TypeScript, SDK oficial)
- [ ] `fs_read`, `fs_write`, `fs_search`
- [ ] `shell_run` con comandos configurados
- [ ] `git_status`, `git_log`
- [ ] `project_info`, `read_resource`

### v0.2
- [ ] `db_query`, `db_schema`
- [ ] `shell_raw` (restringible)
- [ ] Mejoras de seguridad (path validation, rate limiting)
- [ ] npm publish (`@erquier/better-mcp`)

### v0.3
- [ ] Docker image
- [ ] HTTP transport (SSE)
- [ ] Soporte multi-proyecto (monorepo)
- [ ] Documentación + ejemplos

### v1.0
- [ ] **Auth gates** (confirmación humana en writes/deploy)
- [ ] **Workspace mode** (múltiples proyectos simultáneos)
- [ ] Python SDK (`pip install better-mcp`)
- [ ] Plugins personalizados

---

## Desarrollo

```bash
git clone https://github.com/erquier/better-mcp
cd better-mcp
pnpm install
pnpm dev           # Desarrollo con hot-reload
pnpm build         # Producción
pnpm test          # Tests
```

### Stack técnico

- **TypeScript** (SDK MCP oficial de Anthropic)
- **Node.js 18+**
- Opcional: **Docker** para despliegue
- Opcional: **Python** para bindings alternativos

---

## Preguntas frecuentes

**¿Por qué no usar los MCP servers oficiales por separado?**
Porque son piezas independientes que requieren configurar N servidores diferentes. better-mcp los unifica en uno solo con una config compartida y herramientas pensadas para el flujo completo de desarrollo.

**¿Qué lo hace "better"?**
- Un solo comando para instalar y ejecutar
- Config por proyecto en un JSON
- Tools pensadas para el flujo real de desarrollo (no solo CRUD de archivos)
- Escapado correcto de código (no más heredocs rotos)
- Agnóstico al agente (cualquier cliente MCP funciona)

**¿Y si mi proyecto no tiene DB o no usa Git?**
Las tools se habilitan según la config. Si no configuras `db`, no se exponen tools de DB. Si no configuras `git`, no se exponen tools de git.

**¿Es seguro?**
Sí. Cada tool opera bajo las restricciones de la config: paths permitidos, DB read-only, comandos whitelist. Y el server corre localmente con los permisos del usuario que lo ejecuta.

**¿Necesito cambiar mi proyecto para usarlo?**
No. Solo agregar un `better-mcp.json` a la raíz. El resto es configuración de tu cliente MCP.

---

## Licencia

MIT © Erne Santana

---

## Links

- [GitHub](https://github.com/erquier/better-mcp)
- [MCP Protocol](https://modelcontextprotocol.io/)
- [Reportar un issue](https://github.com/erquier/better-mcp/issues)
