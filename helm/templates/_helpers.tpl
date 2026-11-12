{{/* Name of every object of the release. */}}
{{- define "gateway.fullname" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Name of the oauth2-proxy Deployment and Service. */}}
{{- define "gateway.authname" -}}
{{- printf "%s-oauth2-proxy" (include "gateway.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Labels that select the oauth2-proxy Pods; never change them after the first install (selectors are immutable). */}}
{{- define "gateway.authSelectorLabels" -}}
app.kubernetes.io/name: oauth2-proxy
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* Labels on every object. */}}
{{- define "gateway.labels" -}}
app.kubernetes.io/part-of: gateway
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/* Restricted security context of every container. */}}
{{- define "gateway.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- end -}}

{{/* True (non-empty) when the Gateway serves HTTPS. */}}
{{- define "gateway.tls" -}}
{{- if .Values.tls.enabled -}}true{{- end -}}
{{- end -}}

{{/* Namespace of the backend Services when it differs from the release namespace; empty otherwise. */}}
{{- define "gateway.servicesNamespace" -}}
{{- if and .Values.services.namespace (ne .Values.services.namespace .Release.Namespace) -}}{{ .Values.services.namespace }}{{- end -}}
{{- end -}}

{{/* The token issuer: the identity provider's public address (the "iss" claim). */}}
{{- define "gateway.issuer" -}}
{{- if .Values.auth.issuer -}}
{{- .Values.auth.issuer -}}
{{- else -}}
{{- printf "%s://%s/realms/%s" (ternary "https" "http" (not (empty (include "gateway.tls" .)))) .Values.hostname .Values.auth.realm -}}
{{- end -}}
{{- end -}}

{{/* In-cluster address of the identity Service. */}}
{{- define "gateway.identityAddress" -}}
{{- $be := .Values.backends.identity -}}
{{- printf "http://%s.%s.svc:%v" $be.service (default .Release.Namespace .Values.services.namespace) $be.port -}}
{{- end -}}

{{/* Where oauth2-proxy fetches the signing keys. */}}
{{- define "gateway.jwksUrl" -}}
{{- if .Values.auth.jwksUrl -}}
{{- .Values.auth.jwksUrl -}}
{{- else -}}
{{- printf "%s/realms/%s/protocol/openid-connect/certs" (include "gateway.identityAddress" .) .Values.auth.realm -}}
{{- end -}}
{{- end -}}

{{/*
The non-secret settings of oauth2-proxy as YAML map entries (the ConfigMap data). Bearer tokens only: the discovery
is skipped (the keys come from the in-cluster address, the issuer is the public one), the roles are read from the
nested claim and the user from "sub", so a service token without an e-mail address passes too. A login URL, a redeem
URL and a client secret are required by oauth2-proxy although no login flow is ever used.
*/}}
{{- define "gateway.authEnv" -}}
{{- $env := dict
  "OAUTH2_PROXY_PROVIDER" "oidc"
  "OAUTH2_PROXY_CLIENT_ID" .Values.auth.audience
  "OAUTH2_PROXY_OIDC_ISSUER_URL" (include "gateway.issuer" .)
  "OAUTH2_PROXY_SKIP_OIDC_DISCOVERY" "true"
  "OAUTH2_PROXY_OIDC_JWKS_URL" (include "gateway.jwksUrl" .)
  "OAUTH2_PROXY_LOGIN_URL" (printf "%s/protocol/openid-connect/auth" (include "gateway.issuer" .))
  "OAUTH2_PROXY_REDEEM_URL" (printf "%s/realms/%s/protocol/openid-connect/token" (include "gateway.identityAddress" .) .Values.auth.realm)
  "OAUTH2_PROXY_SKIP_JWT_BEARER_TOKENS" "true"
  "OAUTH2_PROXY_OIDC_GROUPS_CLAIM" .Values.auth.rolesClaim
  "OAUTH2_PROXY_OIDC_EMAIL_CLAIM" "sub"
  "OAUTH2_PROXY_EMAIL_DOMAINS" "*"
  "OAUTH2_PROXY_SKIP_CLAIMS_FROM_PROFILE_URL" "true"
  "OAUTH2_PROXY_HTTP_ADDRESS" (printf "0.0.0.0:%v" .Values.auth.port)
  "OAUTH2_PROXY_COOKIE_SECURE" "true"
  "OAUTH2_PROXY_SILENCE_PING_LOGGING" "true" -}}
{{- $env = merge (deepCopy .Values.auth.extraEnv) $env -}}
{{- range $key, $value := $env }}
{{ $key }}: {{ $value | toString | quote }}
{{- end -}}
{{- end -}}

{{/* The ForwardAuth target of oauth2-proxy (the query string is kept by Traefik; allowed_groups restricts by role). */}}
{{- define "gateway.authAddress" -}}
{{- printf "http://%s.%s.svc:%v/oauth2/auth" (include "gateway.authname" .) .Release.Namespace .Values.auth.port -}}
{{- end -}}
