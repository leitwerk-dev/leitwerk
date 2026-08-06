{{/* Expand the chart name. */}}
{{- define "leitwerk.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Create a fully qualified base name. */}}
{{- define "leitwerk.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "leitwerk.serverFullname" -}}
{{- printf "%s-server" (include "leitwerk.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "leitwerk.namespace" -}}
{{- default (default .Release.Namespace .Values.kubernetes.serverNamespace) .Values.namespace.name -}}
{{- end -}}

{{- define "leitwerk.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "leitwerk.labels" -}}
helm.sh/chart: {{ include "leitwerk.chart" . }}
app.kubernetes.io/name: {{ include "leitwerk.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "leitwerk.selectorLabels" -}}
app.kubernetes.io/name: {{ include "leitwerk.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "leitwerk.serverSelectorLabels" -}}
{{ include "leitwerk.selectorLabels" . }}
app.kubernetes.io/component: server
{{- end -}}

{{- define "leitwerk.gatewayFullname" -}}
{{- printf "%s-gateway" (include "leitwerk.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "leitwerk.gatewaySelectorLabels" -}}
{{ include "leitwerk.selectorLabels" . }}
app.kubernetes.io/component: gateway
{{- end -}}

{{- define "leitwerk.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "leitwerk.serverFullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "leitwerk.workerServiceAccountName" -}}
{{- default "leitwerk-worker" .Values.kubernetes.workerServiceAccount -}}
{{- end -}}

{{- define "leitwerk.serverImage" -}}
{{- $image := printf "%s:%s" .Values.server.image.repository .Values.server.image.tag -}}
{{- if .Values.server.image.digest -}}
{{- printf "%s@%s" .Values.server.image.repository .Values.server.image.digest -}}
{{- else -}}
{{- $image -}}
{{- end -}}
{{- end -}}

{{- define "leitwerk.gatewayImage" -}}
{{- $image := printf "%s:%s" .Values.gateway.image.repository .Values.gateway.image.tag -}}
{{- if .Values.gateway.image.digest -}}
{{- printf "%s@%s" .Values.gateway.image.repository .Values.gateway.image.digest -}}
{{- else -}}
{{- $image -}}
{{- end -}}
{{- end -}}

{{- define "leitwerk.internalTlsSecretName" -}}
{{- if .Values.internalTls.secretName -}}
{{- .Values.internalTls.secretName -}}
{{- else -}}
{{- printf "%s-internal-tls" (include "leitwerk.serverFullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "leitwerk.kubernetesServerUrl" -}}
{{- if .Values.kubernetes.serverUrl -}}
{{- .Values.kubernetes.serverUrl -}}
{{- else -}}
{{- $scheme := ternary "https" "http" .Values.internalTls.enabled -}}
{{- printf "%s://%s.%s.svc.cluster.local:%v" $scheme (include "leitwerk.serverFullname" .) (include "leitwerk.namespace" .) (.Values.server.service.port | int) -}}
{{- end -}}
{{- end -}}

{{- define "leitwerk.storageClass" -}}
{{- if . -}}
storageClassName: {{ . | quote }}
{{- end -}}
{{- end -}}
