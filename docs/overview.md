# Leitwerk overview

Leitwerk standardizes AI-assisted workflows for teams. Teams define the steps and where people must review or approve results. Leitwerk coordinates the work, tracks progress, and makes results visible.

![Leitwerk](images/leitwerk.png)

## Example workflows

- **Standardized software delivery:** request → plan → approval → implementation → tests → review.
- **Monitoring:** check logs → analyze → create ticket.
- **Issue triage:** incoming issue → analysis → proposed action → team decision.

## Choose the model for each step

Each step, called a **turn**, can use a different AI model. A privately hosted model can handle sensitive information, while a state-of-the-art model makes code changes.

## Who does what

- **People** start work, provide guidance, and review results through a web interface. They can stop work or retry failed steps.
- **The Leitwerk server** coordinates the workflow. It saves progress, assigns steps to workers, and responds to decisions and updates from other systems.
- **Workers** carry out assigned steps using AI and other tools, then report their results to the server.

```mermaid
%%{init: {"theme": "base", "themeVariables": {"lineColor": "#708096", "textColor": "#25324a", "edgeLabelBackground": "#f3f5fa"}, "flowchart": {"curve": "linear", "nodeSpacing": 24, "rankSpacing": 36}}}%%
flowchart TB
    accTitle: How Leitwerk coordinates work
    accDescr: People guide the server through a web interface. The server assigns steps to workers and exchanges updates with external systems. Workers use private or hosted AI services.

    people("People<br/>Guide and review")

    subgraph leitwerk["Leitwerk"]
        server("Server<br/>Coordinates work")
        workers("Workers<br/>Carry out steps")
        server <-->|Steps and results| workers
    end

    people <-->|Web interface| server
    server <-->|Updates| systems["External Systems<br/>Issues, reviews and builds"]
    workers <--> models["AI services<br/>Private or hosted"]

    classDef core fill:#e2e9ff,stroke:#4051b5,color:#25324a,stroke-width:1.5px
    classDef external fill:#f3f5fa,stroke:#8794ad,color:#25324a
    class server,workers core
    class people,systems,models external
    style leitwerk fill:#f3f5fa,stroke:#8794ad,color:#25324a
```

## Connected systems

Leitwerk connects to AI services and existing team tools, such as issue trackers, code repositories, code-review tools, and build systems.

Each workflow uses the connections it needs. Leitwerk coordinates these systems; it does not replace them.
