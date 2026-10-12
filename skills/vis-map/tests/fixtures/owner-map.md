# Sample application
- **Type**: Entity
- **Importance**: Critical
- **Responsibilities**: Synthetic MAP regression fixture.

## Runtime
- **Type**: Entity
- **Importance**: Significant
- **Responsibilities**: Owns a worker.

### Worker
- **Type**: Entity
- **Importance**: Peripheral
- **Responsibilities**: Handles a request.

## DataTypes

### Request
- **Type**: DataType
- **Format**: JSON schema
- **Schema**: { "id": "string" }

## Relationships

- Runtime → Worker
  - **Type**: Interact
  - **DataType**: Request
