# better-mcp 🚀

> **El puente definitivo entre agentes de IA y tu proyecto.**

better-mcp es un **MCP server universal** que cualquier agente (Hermes, Claude Code, Cursor, Copilot, Cline, cualquier cliente MCP) puede usar para interactuar con tu proyecto como un desarrollador humano, pero más rápido y sin fricción.

```bash
# Una vez instalado, cualquier agente conectado puede:
npx better-mcp run         # Arrancar el server MCP
# → tools: fs_read, fs_write, fs_search, fs_list, db_query, db_schema,
#          shell_run, shell_raw, git_status, git_log, git_diff,
#          project_info, read_resource
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

## Quick Start

### 1. Instalar

```bash
# Global (recomendado)
npm install -g @erquier/better-mcp

# O via npx (sin instalación)
npx @erquier/better-mcp run
```

### 2. Crear `better-mcp.json` en la raíz del proyecto

Configuración completa — agrega los tool groups que necesites:

```json
{
  "$schema": "https://raw.githubusercontent.com/erquier/better-mcp/main/better-mcp.schema.json",
  "project": "mi-app",
  "root": "/path/to/project",
  "stack": ["nextjs", "prisma", "postgres", "docker"],
  "tools": {
    "fs": {
      "allowedPaths": ["/path/to/project"],
      "maxFileSize": 10485760
    },
    "db": {
      "url": "${DATABASE_URL}",
      "readOnly": true,
      "schemas": ["public"],
      "maxRows": 500
    },
    "shell": {
      "commands": {
        "tsc": "npx tsc --noEmit",
        "build": "docker compose build",
        "test": "pnpm test",
        "lint": "pnpm lint",
        "deploy": "./scripts/deploy.sh"
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
    "docs": "docs/",
    "schema": "prisma/schema.prisma"
  }
}
```

### 3. Conectarlo desde cualquier cliente MCP

**Hermes Agent** (`~/.hermes/config.yaml`):
```yaml
mcp:
  servers:
    mi-proyecto:
      command: npx
      args: ["@erquier/better-mcp", "run"]
      env:
        DATABASE_URL: "postgresql://user:pass@localhost:5432/mydb"
```

**Claude Desktop** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "mi-proyecto": {
      "command": "npx",
      "args": ["@erquier/better-mcp", "run"],
      "env": {
        "DATABASE_URL": "postgresql://user:pass@localhost:5432/mydb"
      }
    }
  }
}
```

**Cursor / Cline / Cualquier cliente MCP**: mismo patrón.

### 4. Usar las tools desde cualquier agente

Una vez conectado, el agente puede llamar:
```
▶ fs_read("src/app/page.tsx")
▶ shell_run("tsc")
▶ db_query("SELECT id, name FROM products LIMIT 5")
▶ git_status()
▶ project_info()
```

---

## Tools disponibles — API completa

### 📁 Filesystem (`fs_*`)

Requiere `tools.fs` en la config.

| Tool | Input | Returns | Descripción |
|---|---|---|---|
| `fs_read(path, offset?, limit?)` | `path: string`, `offset?: number` (1-indexed, default 1), `limit?: number` (max 2000, default 500) | `{ content, totalLines, fileSize }` | Lee archivo con paginación automática. Bloquea path traversal. |
| `fs_write(path, content)` | `path: string`, `content: string` | `{ path, bytesWritten }` | Escribe archivo (escaping correcto). Crea directorios. Límite 10MB. |
| `fs_search(pattern, fileGlob?, limit?)` | `pattern: string` (regex, max 500 chars), `fileGlob?: string`, `limit?: number` (max 500, default 50) | `{ matches: [{ file, line, content }] }` | Grep regex en el proyecto. Usa `rg` (ripgrep). |
| `fs_list(path)` | `path: string` | `[{ name, type: "file"\|"dir"\|"symlink", size }]` | Lista contenido del directorio (máx 10,000 entries). |

#### Ejemplos de output

**`fs_read("package.json", 1, 5)`**:
```json
{
  "content": "{\n  \"name\": \"@erquier/better-mcp\",\n  \"version\": \"0.1.0\",\n  \"description\": \"MCP server universal...\",\n  \"type\": \"module\"",
  "totalLines": 55,
  "fileSize": 1116
}
```

**`fs_write("test.txt", "hello world")`**:
```json
{
  "path": "/tmp/better-mcp/test.txt",
  "bytesWritten": 11
}
```

**`fs_search("import", "*.ts")`**:
```json
{
  "matches": [
    { "file": "src/server.ts", "line": 1, "content": "import { Server } from \"@modelcontextprotocol/sdk/server/index.js\";" },
    { "file": "src/config.ts", "line": 1, "content": "import { readFileSync, existsSync } from \"fs\";" }
  ]
}
```

**`fs_list(".")`**:
```json
[
  { "name": "src", "type": "dir", "size": 4096 },
  { "name": "package.json", "type": "file", "size": 1116 },
  { "name": "tsconfig.json", "type": "file", "size": 390 }
]
```

### 🗄️ Database (`db_*`)

Requiere `tools.db` en la config y `psql` instalado.

| Tool | Input | Returns | Descripción |
|---|---|---|---|
| `db_query(sql)` | `sql: string` (SELECT/WITH only en read-only, max 100K chars) | `{ columns, rows, rowCount, truncated }` | SQL read-only, resultados paginados (LIMIT automático). |
| `db_schema(schemas?)` | `schemas?: string[]` (filtro, default: config o `["public"]`) | `{ tables: [{ schema, name, columns, indexes, rowCountEstimate }] }` | Schema completo: tablas, columnas, tipos, nullable, defaults, primary keys. |

#### Seguridad
- **Read-only por defecto**: solo `SELECT` y `WITH` en modo read-only.
- **Sanitización**: validación de schema names contra inyección SQL.
- **URL validation**: solo URLs que comiencen con `postgres://` o `postgresql://`.
- **Límite de query**: max 100,000 caracteres.

#### Ejemplos de output

**`db_query("SELECT id, name, email FROM users LIMIT 3")`**:
```json
{
  "columns": ["id", "name", "email"],
  "rows": [
    { "id": "1", "name": "Alice", "email": "alice@example.com" },
    { "id": "2", "name": "Bob", "email": "bob@example.com" },
    { "id": "3", "name": "Charlie", "email": "charlie@example.com" }
  ],
  "rowCount": 3,
  "truncated": false
}
```

**`db_schema()`**:
```json
{
  "tables": [
    {
      "schema": "public",
      "name": "users",
      "columns": [
        { "name": "id", "type": "integer", "nullable": false, "default": "nextval('users_id_seq'::regclass)", "isPrimaryKey": true },
        { "name": "name", "type": "character varying", "nullable": false, "default": null, "isPrimaryKey": false },
        { "name": "email", "type": "character varying", "nullable": false, "default": null, "isPrimaryKey": false }
      ],
      "indexes": [],
      "rowCountEstimate": 0
    }
  ]
}
```

### 🖥️ Shell (`shell_*`)

Requiere `tools.shell` en la config.

| Tool | Input | Returns | Descripción |
|---|---|---|---|
| `shell_run(command)` | `command: string` (nombre del comando, max 100 chars) | `{ stdout, stderr, exitCode, duration }` | Ejecuta comando predefinido de la config. |
| `shell_raw(command, timeout?)` | `command: string` (max 10K chars), `timeout?: number` (default 120s, max 3600s) | `{ stdout, stderr, exitCode, duration }` | Comando shell arbitrario (solo si `allowRaw: true`). |

#### Seguridad
- **Whitelist**: `shell_run` solo ejecuta comandos definidos en `commands`.
- **Raw validation**: `shell_raw` bloquea backticks (` `` `) y newlines para evitar inyección.
- **Límite de output**: max 10MB.
- **Variables de entorno**: `PROJECT_ROOT` se inyecta automáticamente.
- **Timeout**: default 5 min para `shell_run`, 2 min para `shell_raw`.

#### Ejemplos de output

**`shell_run("test")`** (con config `"test": "echo 'tests ok'"`):
```json
{
  "stdout": "tests ok",
  "stderr": "",
  "exitCode": 0,
  "duration": 45
}
```

**`shell_run("fail")`** (con config `"fail": "exit 1"`):
```json
{
  "stdout": "",
  "stderr": "",
  "exitCode": 1,
  "duration": 12
}
```

### 🔗 Git (`git_*`)

Habilitado por defecto. Requiere que el proyecto sea un repositorio git.

| Tool | Input | Returns | Descripción |
|---|---|---|---|
| `git_status()` | — | `{ branch, isClean, staged[], unstaged[], untracked[], ahead, behind, lastCommit }` | Branch, cambios staged/unstaged, last commit. |
| `git_log(limit?)` | `limit?: number` (default 10, max 1000) | `[{ hash, message, author, date }]` | Historial de commits. |
| `git_diff(target?)` | `target?: string` (git ref, default HEAD) | `{ files[], patch }` | Diff de cambios o contra referencia. |

#### Seguridad
- **Argumentos seguros**: usa `execFileSync` con arreglo de args (no shell string).
- **Validación de ref**: caracteres peligrosos bloqueados (null bytes, quotes, pipes, etc.).
- **Max output**: 10MB.

#### Ejemplos de output

**`git_status()`**:
```json
{
  "branch": "main",
  "isClean": false,
  "staged": ["src/server.ts"],
  "unstaged": ["README.md"],
  "untracked": ["better-mcp.schema.json"],
  "ahead": 2,
  "behind": 0,
  "lastCommit": {
    "hash": "a1b2c3d4e5f6...",
    "message": "feat: add database tools",
    "author": "Erne Santana",
    "date": "2025-06-22 14:30:00 -0400"
  }
}
```

**`git_log(3)`**:
```json
[
  {
    "hash": "a1b2c3d4e5f6...",
    "message": "feat: add database tools",
    "author": "Erne Santana",
    "date": "2025-06-22 14:30:00 -0400"
  },
  {
    "hash": "b2c3d4e5f6a7...",
    "message": "feat: initial shell tools",
    "author": "Erne Santana",
    "date": "2025-06-21 10:15:00 -0400"
  }
]
```

**`git_diff()`**:
```json
{
  "files": ["src/server.ts", "README.md"],
  "patch": "diff --git a/src/server.ts b/src/server.ts\nindex abc..def 100644\n--- a/src/server.ts\n+++ b/src/server.ts\n@@ -1,3 +1,4 @@\n+// new line\n import { Server } from \"...\";"
}
```

### ℹ️ Project (`project_*`)

Siempre disponible (no requiere config específica).

| Tool | Input | Returns | Descripción |
|---|---|---|---|
| `project_info()` | — | `{ project, name, description, root, stack, directoryCount, fileCount, totalSizeBytes, hasConfig, enabledTools, availableCommands, resources }` | Stack, estructura, configs detectados, tools habilitadas. |
| `read_resource(name)` | `name: string` | `{ name, content, path }` | Lee recurso del proyecto (handoff, plan, doc, schema). |

#### Ejemplos de output

**`project_info()`**:
```json
{
  "project": "better-mcp",
  "name": "Better MCP Server",
  "description": "MCP server for AI agents",
  "root": "/home/user/better-mcp",
  "stack": ["typescript", "node"],
  "directoryCount": 8,
  "fileCount": 24,
  "totalSizeBytes": 48512,
  "hasConfig": {
    "node": true,
    "typescript": true,
    "docker": true,
    "github-actions": false
  },
  "enabledTools": ["filesystem", "shell", "git"],
  "availableCommands": ["tsc", "build", "test", "lint", "deploy"],
  "resources": {
    "handoff": "/home/user/better-mcp/HANDOFF.md",
    "schema": "/home/user/better-mcp/prisma/schema.prisma"
  }
}
```

**`read_resource("handoff")`**:
```json
{
  "name": "handoff",
  "content": "# Project Handoff\n\nThis is the README content...",
  "path": "/home/user/better-mcp/HANDOFF.md"
}
```

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

La imagen Docker es **multi-stage**:
- **Builder stage**: compila TypeScript.
- **Runner stage**: imagen Alpine minimalista con `postgresql-client` para DB tools.

### Python (futuro)
```bash
pip install better-mcp
```

---

## Configuración completa

El archivo `better-mcp.json` puede ir en la raíz del proyecto o pasarse con `npx better-mcp run path/to/better-mcp.json`.

### Schema de validación

Un schema JSON completo está disponible para autocompletado en IDE:
- **URL**: `https://raw.githubusercontent.com/erquier/better-mcp/main/better-mcp.schema.json`
- **Archivo local**: `better-mcp.schema.json`

Agrégalo a tu config:
```json
{
  "$schema": "https://raw.githubusercontent.com/erquier/better-mcp/main/better-mcp.schema.json"
}
```

### Campos de configuración

| Campo | Tipo | Requerido | Default | Descripción |
|---|---|---|---|---|
| `project` | `string` | ✅ | — | Identificador corto del proyecto |
| `root` | `string` | ✅ | — | Ruta absoluta al proyecto |
| `name` | `string` | ❌ | `project` | Nombre para mostrar |
| `description` | `string` | ❌ | `""` | Descripción breve |
| `stack` | `string[]` | ❌ | `[]` | Tags de tecnología |
| `tools.fs` | `object` | ❌ | — | Filesystem tools |
| `tools.fs.allowedPaths` | `string[]` | ✅* | — | Paths absolutos permitidos |
| `tools.fs.maxFileSize` | `number` | ❌ | 52428800 (50MB) | Máximo tamaño de archivo |
| `tools.db` | `object` | ❌ | — | Database tools |
| `tools.db.url` | `string` | ✅* | — | URL PostgreSQL (soporta `${VAR}`) |
| `tools.db.readOnly` | `boolean` | ❌ | `true` | Solo SELECT/WITH |
| `tools.db.schemas` | `string[]` | ❌ | `["public"]` | Schemas para db_schema |
| `tools.db.maxRows` | `number` | ❌ | 500 | Límite de filas |
| `tools.shell` | `object` | ❌ | — | Shell tools |
| `tools.shell.commands` | `object` | ✅* | — | Map nombre → comando shell |
| `tools.shell.allowRaw` | `boolean` | ❌ | `false` | Habilitar shell_raw |
| `tools.git` | `object` | ❌ | — | Git tools |
| `tools.git.enabled` | `boolean` | ❌ | `true` | Habilitar/deshabilitar git |
| `tools.git.maxCommits` | `number` | ❌ | 50 | Máx commits en git_log |
| `resources` | `object` | ❌ | `{}` | Recursos nombre → path |

*\* Requerido si el grupo de tools está presente.*

### Variables de entorno

El config soporta `${VAR_NAME}` que se resuelven del entorno en tiempo de ejecución. Útil para credenciales de DB, tokens, etc.

```json
{
  "tools": {
    "db": {
      "url": "${DATABASE_URL}"
    }
  }
}
```

### Modos de ejecución (CLI)

```bash
# Modo automático (busca better-mcp.json en cwd)
better-mcp

# Modo explícito
better-mcp run

# Con ruta de config
better-mcp run path/to/config.json
better-mcp --config path/to/config.json
better-mcp path/to/config.json
```

---

## Diagrama de arquitectura

```
┌─────────────────┐     MCP protocol     ┌──────────────────────────┐
│ Hermes Agent    │◄───────────────────►│                          │
│ Claude Code     │                      │   better-mcp server       │
│ Cursor          │                      │   (stdio transport)      │
│ Cline           │                      │                          │
│ Cualquier       │                      ├──────────────────────────┤
│ cliente MCP     │                      │                          │
└─────────────────┘                      │  Tools:                  │
                                          │  ├─ fs_read             │
┌─────────────────┐                       │  ├─ fs_write            │
│ Config          │                       │  ├─ fs_search           │
│                 │                       │  ├─ fs_list             │
│ better-mcp.json ├───────cargado────────►│  ├─ db_query            │
│ (JSON Schema)   │                       │  ├─ db_schema           │
└─────────────────┘                       │  ├─ shell_run            │
                                          │  ├─ shell_raw            │
                                          │  ├─ git_status          │
                                          │  ├─ git_log             │
                                          │  ├─ git_diff            │
                                          │  ├─ project_info        │
                                          │  └─ read_resource       │
                                          │                          │
                                          └──────────┬───────────────┘
                                                     │
            ┌────────────────────────────────────────┼────────────────────────┐
            │           Ejecución controlada          │                        │
            ▼                                        ▼                        ▼
   ┌──────────────┐                        ┌──────────────┐        ┌──────────────┐
   │  Filesystem  │    ┌──────────────┐    │   Database   │        │     Git      │
   │  (read/write │    │ Shell (build │    │  (SQL RO)    │        │ (status/log/ │
   │   /search)   │    │  /test/lint) │    │              │        │    diff)     │
   └──────────────┘    └──────────────┘    └──────────────┘        └──────────────┘
```

El server corre como proceso stdio (transporte MCP estándar) y expone tools MCP estándar. Cada tool opera sobre el proyecto usando la configuración provista. No necesita permisos especiales más allá del acceso que tenga el usuario que lo ejecuta.

---

## Seguridad

| Mecanismo | Descripción |
|---|---|
| **Read-only DB** | `db_query` solo ejecuta SELECT/WITH por defecto |
| **Comandos whitelist** | `shell_run` solo ejecuta comandos definidos en config |
| **Raw sanitization** | `shell_raw` bloquea backticks y newlines |
| **Paths restringidos** | `fs_*` solo opera dentro de `allowedPaths` con validación symlink |
| **Null byte rejection** | Todas las rutas son validadas contra null bytes |
| **Size limits** | Max file read: 50MB, max write: 10MB, max output: 10MB |
| **Timeout control** | Shell commands tienen timeouts configurables (max 3600s) |
| **Sin red** | Sin conexiones externas (excepto la DB configurada) |
| **Input validation** | Todos los inputs de usuario son validados (tipos, longitudes, caracteres) |
| **Sin dependencias externas** | Solo el SDK MCP oficial |

Para ambientes restrictivos: deshabilitar `shell.allowRaw`, limitar `db.schemas`, o configurar `git.enabled: false`.

---

## Roadmap

### MVP (v0.1) — ✅ Completado
- [x] Config `better-mcp.json`
- [x] Server MCP base (TypeScript, SDK oficial)
- [x] `fs_read`, `fs_write`, `fs_search`, `fs_list`
- [x] `shell_run` con comandos configurados
- [x] `git_status`, `git_log`, `git_diff`
- [x] `project_info`, `read_resource`

### v0.2 — ✅ Completado
- [x] `db_query`, `db_schema`
- [x] `shell_raw` (restringible)
- [x] Mejoras de seguridad (path validation symlink, null bytes, rate limiting input validation)
- [x] Docker image (multi-stage build)
- [x] Testing suite completa (Vitest, 70+ tests)
- [x] npm publish (`@erquier/better-mcp`)
- [x] JSON Schema para IDE autocomplete
- [x] CONTRIBUTING.md

### v0.3
- [ ] HTTP transport (SSE)
- [ ] Soporte multi-proyecto (monorepo)
- [ ] Integración CI/CD (GitHub Actions)
- [ ] Documentación multi-idioma

### v1.0
- [ ] **Auth gates** (confirmación humana en writes/deploy)
- [ ] **Workspace mode** (múltiples proyectos simultáneos)
- [ ] Python SDK (`pip install better-mcp`)
- [ ] Plugins personalizados

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

## Desarrollo

```bash
git clone https://github.com/erquier/better-mcp
cd better-mcp
pnpm install
pnpm dev           # Desarrollo con watch (tsc --watch)
pnpm build         # Producción
pnpm test          # Tests (Vitest)
npx tsc --noEmit   # Type-check solo
```

### Prerrequisitos

- **Node.js 18+**
- **pnpm** (corepack enable)
- **ripgrep** (`rg`) — necesario para `fs_search` y sus tests
- PostgreSQL client (`psql`) — necesario para DB tools

### Stack técnico

- **TypeScript** (strict mode, ES2022)
- **@modelcontextprotocol/sdk** ^1.0.0
- **Vitest** para testing
- **Docker** (multi-stage build, opcional)
- **pnpm** como package manager

---

## Preguntas frecuentes

**¿Por qué no usar los MCP servers oficiales por separado?**
Porque son piezas independientes que requieren configurar N servidores diferentes. better-mcp los unifica en uno solo con una config compartida y herramientas pensadas para el flujo completo de desarrollo.

**¿Qué lo hace "better"?**
- Un solo comando para instalar y ejecutar
- Config por proyecto en un JSON con schema de validación
- Tools pensadas para el flujo real de desarrollo (no solo CRUD de archivos)
- Escapado correcto de código (no más heredocs rotos)
- Agnóstico al agente (cualquier cliente MCP funciona)

**¿Y si mi proyecto no tiene DB o no usa Git?**
Las tools se habilitan según la config. Si no configuras `db`, no se exponen tools de DB. Si deshabilitas `git`, no se exponen tools de git.

**¿Es seguro?**
Sí. Cada tool opera bajo las restricciones de la config: paths permitidos, DB read-only, comandos whitelist, inputs validados. Y el server corre localmente con los permisos del usuario que lo ejecuta.

**¿Necesito cambiar mi proyecto para usarlo?**
No. Solo agregar un `better-mcp.json` a la raíz. El resto es configuración de tu cliente MCP.

**¿Qué es MCP?**
El [Model Context Protocol](https://modelcontextprotocol.io/) es un protocolo abierto que permite a agentes de IA interactuar con herramientas y recursos externos de manera estructurada.

---

## Licencia

MIT © Erne Santana

---

## Links

- [GitHub](https://github.com/erquier/better-mcp)
- [JSON Schema](https://raw.githubusercontent.com/erquier/better-mcp/main/better-mcp.schema.json)
- [MCP Protocol](https://modelcontextprotocol.io/)
- [Reportar un issue](https://github.com/erquier/better-mcp/issues)
