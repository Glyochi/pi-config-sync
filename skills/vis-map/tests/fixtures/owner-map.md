<!-- map-format: compact-v1 -->

# Sample application
- **Type**: Entity
- **Responsibilities**: Application boundary.

## Runtime
- **Type**: Entity
- **Responsibilities**: Coordinates requests.

### Worker
- **Type**: Entity
- **Responsibilities**: Performs a unit of work.

## Utilities
- **Type**: Entity
- **Responsibilities**: Standalone helper branch.

## DataTypes

### Request
- **Type**: DataType
- **Format**: text summary
- **Schema**: Request payload.

## Relationships

- Runtime → Worker
  - **Type**: Interact
  - **DataType**: Request
