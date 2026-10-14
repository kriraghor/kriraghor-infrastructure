{{- define "app.name" -}}
{{- default .Release.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "app.labels" -}}
app.kubernetes.io/name: {{ include "app.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ include "app.tag" . | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: kriraghor
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- with .Values.labels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{- define "app.selector" -}}
app.kubernetes.io/name: {{ include "app.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "app.tag" -}}
{{- default .Chart.AppVersion .Values.image.tag -}}
{{- end -}}

{{- define "app.probePort" -}}
{{- if .Values.opsPort }}ops{{ else }}http{{ end -}}
{{- end -}}

{{- define "app.secretName" -}}
{{- default (printf "%s-env" (include "app.name" .)) .Values.externalSecret.targetName -}}
{{- end -}}

{{/* Pod spec shared by the Deployment and the Job. */}}
{{- define "app.podSpec" -}}
serviceAccountName: {{ include "app.name" . }}
automountServiceAccountToken: {{ .Values.serviceAccount.automountToken }}
securityContext:
  {{- toYaml .Values.podSecurityContext | nindent 2 }}
terminationGracePeriodSeconds: {{ .Values.terminationGracePeriodSeconds }}
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- if and .Values.topologySpread (eq .Values.kind "Deployment") }}
topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: kubernetes.io/hostname
    whenUnsatisfiable: ScheduleAnyway
    labelSelector:
      matchLabels:
        {{- include "app.selector" . | nindent 8 }}
{{- end }}
containers:
  - name: {{ include "app.name" . }}
    image: "{{ .Values.image.repository }}:{{ include "app.tag" . }}"
    imagePullPolicy: {{ .Values.image.pullPolicy }}
    {{- with .Values.command }}
    command:
      {{- toYaml . | nindent 6 }}
    {{- end }}
    {{- with .Values.args }}
    args:
      {{- toYaml . | nindent 6 }}
    {{- end }}
    {{- if or .Values.containerPort .Values.opsPort }}
    ports:
      {{- if .Values.containerPort }}
      - name: http
        containerPort: {{ .Values.containerPort }}
        protocol: TCP
      {{- end }}
      {{- if .Values.opsPort }}
      - name: ops
        containerPort: {{ .Values.opsPort }}
        protocol: TCP
      {{- end }}
    {{- end }}
    {{- if .Values.env }}
    env:
      {{- range $k, $v := .Values.env }}
      - name: {{ $k }}
        value: {{ $v | toString | quote }}
      {{- end }}
    {{- end }}
    {{- if or .Values.envFromSecrets .Values.envFromConfigMaps .Values.externalSecret.enabled }}
    envFrom:
      {{- range .Values.envFromConfigMaps }}
      - configMapRef:
          name: {{ . }}
      {{- end }}
      {{- range .Values.envFromSecrets }}
      - secretRef:
          name: {{ . }}
      {{- end }}
      {{- if .Values.externalSecret.enabled }}
      - secretRef:
          name: {{ include "app.secretName" . }}
      {{- end }}
    {{- end }}
    {{- if and (eq .Values.kind "Deployment") (or .Values.containerPort .Values.opsPort) }}
    startupProbe:
      httpGet:
        path: {{ .Values.probes.startup.path }}
        port: {{ include "app.probePort" . }}
      periodSeconds: {{ .Values.probes.startup.periodSeconds }}
      failureThreshold: {{ .Values.probes.startup.failureThreshold }}
    livenessProbe:
      httpGet:
        path: {{ .Values.probes.liveness.path }}
        port: {{ include "app.probePort" . }}
      periodSeconds: {{ .Values.probes.liveness.periodSeconds }}
      failureThreshold: {{ .Values.probes.liveness.failureThreshold }}
    readinessProbe:
      httpGet:
        path: {{ .Values.probes.readiness.path }}
        port: {{ include "app.probePort" . }}
      periodSeconds: {{ .Values.probes.readiness.periodSeconds }}
      failureThreshold: {{ .Values.probes.readiness.failureThreshold }}
    {{- end }}
    resources:
      {{- toYaml .Values.resources | nindent 6 }}
    securityContext:
      {{- toYaml .Values.securityContext | nindent 6 }}
    {{- with .Values.writableDirs }}
    volumeMounts:
      {{- range $i, $dir := . }}
      - name: writable-{{ $i }}
        mountPath: {{ $dir }}
      {{- end }}
    {{- end }}
{{- with .Values.writableDirs }}
volumes:
  {{- range $i, $dir := . }}
  - name: writable-{{ $i }}
    emptyDir: {}
  {{- end }}
{{- end }}
{{- end -}}
