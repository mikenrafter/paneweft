// A valid run whose output bundle also carries an invalid member: two view definitions forwarding to each
// other (alias cycle, pointers /bundle/definitions/N/forward). Used to prove runner output is imported atomically.
import { assertion, runDocument, writeOutput } from "./_common.mjs";

const definition = (id, other) => ({
  id, entityKind: "json/value", title: id, component: "list", requires: [], dataRole: "raw",
  forward: { entityId: "watch", viewDefinitionId: other },
});
writeOutput(runDocument({
  status: "passed",
  assertions: [assertion("a1", "claims success", true)],
  definitions: [definition("loop-a", "loop-b"), definition("loop-b", "loop-a")],
}));
