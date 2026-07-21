# Workspace Behavioral Rules & Guidelines

## Documentation Rule
- **Machine Readability**: The API MUST maintain an up-to-date OpenAPI 3.0 specification (`/api/v1/openapi.json`) and machine-parsable schema definitions.
- **Auto-Sync**: Whenever a new endpoint is added, modified, or removed, `api/index.ts`, `/docs/openapi.json`, and `/public/index.html` MUST be updated in the same change.
- **Strict Formatting**: JSON schema types, query parameters, path variables, and response structures must be strictly typed and explicitly documented for automated LLM agents and clients.
