# Scenario overview

## Scenarios

### Scenario: Process a request {#process-request}
A short request path with one alternate result and a focused linked scenario.

#### Group: Request path {#request-path}
1. Receive a request {#receive} [actor: Client]
2. Validate the request {#validate} [actor: API]
##### Group: Handler work {#handler-work}
3. Run the handler {#handle} [actor: Worker]
4. Return the result {#return} [actor: API]

#### Connections
- validate -> return: request is invalid
- return -> receive: another request arrives [repeat]
- validate -> @validation-details: validation fails

### Scenario: Validation details {#validation-details}
A focused error path.

#### Group: Error response {#error-response}
1. Format the validation error {#format-error} [actor: API]
2. Send the error response {#send-error} [actor: API]
