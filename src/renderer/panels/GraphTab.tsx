import Builder from "@/components/Builder"

// The graph editor is not reimplemented here. This is the same component the
// web app renders at /builder/[id], asked to lay itself out inside a tab
// instead of a browser viewport. Everything it knows how to do — the node
// palette, running a graph, live node status, the missing-key panel — arrives
// for free, and a fix made in either product lands in both.

export function GraphTab({ workflowId }: { workflowId: string }) {
  return (
    // `data-graph` : c'est là qu'on lit son badge d'enregistrement avant de
    // le fermer (lib/graphSave).
    <div className="h-full w-full" data-graph={workflowId}>
      <Builder params={{ id: workflowId }} embedded />
    </div>
  )
}
