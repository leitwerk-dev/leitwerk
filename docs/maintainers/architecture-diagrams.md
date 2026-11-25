# Architecture diagrams

These C4 views are rendered from the [LikeC4](https://likec4.dev/) model in `docs/maintainers/likec4/`. Click a diagram to open it full screen, follow its elements into deeper views, and browse the rest of the model. For the reasoning behind the structure, read [System architecture](architecture.md).

## System context

```likec4-view
index
```

## Containers

```likec4-view
containers
```

## Components

### Server

Open a component group to zoom into the web API, process orchestration, process engine, worker execution, and extension views.

```likec4-view
serverComponents
```

### Process execution unit

```likec4-view
executionUnit
```

### Web UI

```likec4-view
uiComponents
```

## Deployment

### Local development

```likec4-view
localDeployment
```

### Docker Compose

```likec4-view
dockerDeployment
```

### Kubernetes

```likec4-view
kubernetesDeployment
```

## Edit the diagrams

Preview model changes with `npx likec4 start docs/maintainers/likec4`. Embed a view in any page with a `likec4-view` fence that holds only its id; see [Documentation checks](testing.md#documentation-checks).
