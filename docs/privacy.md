# Privacy Policy

**Last updated: September 18, 2026**

Agentic Health Platform is an experimental software project for wellness,
fitness, training guidance, and software engineering exploration.

This policy describes how the current local development version handles
authorized wellness data and credentials.

## Data access

The application may access data from supported wellness providers when the user
explicitly authorizes access.

The current Oura integration requests only the following OAuth scopes:

- `daily`
- `workout`

These scopes are used to support health and training-related functionality such
as local inspection, normalization, and evidence-backed training features.

The application does not intentionally request unrelated Oura data categories.

## Oura authorization

Access to Oura is authorized through Oura's OAuth authorization flow.

OAuth access and refresh tokens are stored locally using the operating system's
credential storage. The current macOS implementation stores credentials in
macOS Keychain.

OAuth credentials, access tokens, and refresh tokens are not committed to the
project repository.

## Data use

Authorized wellness data is used only for functionality provided by Agentic
Health Platform.

The project is intended for wellness, fitness, and training guidance. It is not
intended for medical diagnosis, treatment, or use as a medical device.

## Oura REST data and AI services

Health data obtained through the Oura REST API is kept separate from external
AI and large-language-model processing.

Oura user data obtained through the REST API is not sent to OpenAI or another
external LLM or AI platform.

If the project later provides AI functionality using live Oura user data, that
integration will use a provider-permitted mechanism, such as Oura's official
MCP service where required by the applicable Oura terms.

Synthetic or fabricated health data may be used for software development,
testing, and AI evaluation.

## Local processing and storage

The current implementation stores OAuth credentials locally in the operating
system credential store.

The current implementation does not maintain a persistent local cache of Oura
health data.

Future functionality may process authorized Oura health data locally for the
duration necessary to perform an explicit operation such as inspection or
normalization.

If persistent storage of Oura health data is introduced in a future version,
this privacy policy will be updated before that behavior is enabled.

Real user health data is not included in the project's public source code,
committed test fixtures, or shared evaluation data.

## Third-party services

Provider data is handled according to the requirements applicable to that data
provider.

Oura REST user data is not provided to external AI or LLM services.

The project may use external software-development or AI services with synthetic,
fabricated, or otherwise permitted data.

## Retention and deletion

OAuth access and refresh credentials remain in the local operating-system
credential store until they are replaced, expire, or are removed.

Running the application's logout functionality removes locally stored Oura
credentials.

Local logout does not itself revoke the authorization maintained by Oura.
Users may separately revoke the Agentic Health Platform integration through
their Oura account or Oura application settings.

Revoking provider authorization prevents the application from obtaining new
provider data.

The current application does not persist Oura health data outside the
processing required for an active local operation. If persistent Oura-derived
data is introduced later, deletion and retention behavior will be documented
here before that functionality is enabled.

Users may request deletion of application-held personal data by contacting the
address below. Applicable provider-data deletion and consent-withdrawal
requirements will be honored.

## Consent and withdrawal

Access to provider data requires the user's authorization through the
provider's consent flow.

Users may withdraw that authorization through the provider's integration
settings.

After authorization is withdrawn, the application must not continue accessing
provider data using that authorization.

## Security

The project is designed to:

- keep credentials and OAuth tokens out of source control
- store OAuth credentials using platform credential storage
- avoid logging raw health data or secrets
- use synthetic data in committed tests and evaluation fixtures
- separate provider REST data from external AI processing
- request only the provider scopes needed for enabled functionality

## Changes to this policy

This policy may be updated as the project's functionality changes.

Material changes to provider-data storage, retention, sharing, or AI processing
will be reflected in this policy before the corresponding functionality is
enabled.

## Contact

For questions or data-deletion requests regarding this privacy policy, contact:

agentic-health-platform@gmail.com

