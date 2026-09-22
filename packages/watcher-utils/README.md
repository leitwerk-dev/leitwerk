
`createPollSchedule(clock?)` reserves a deadline for each caller-owned key before
work starts. Invalid intervals use 30 seconds. Extensions use `deps.polling.create`
for the server polling lifecycle. Trigger-file helpers are private to
`showcase-processes` and are no longer exported here.
