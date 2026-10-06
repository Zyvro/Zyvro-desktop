import { TaskQueueButton } from "~/panels/TaskQueueButton"
import { taskTurnEnded } from "~/state/tasks"
import type { AgentPlugin } from "./types"

// La file de tâches. Son horloge vit dans state/tasks et ne lance rien tant
// que le plugin est éteint (voir `tickTasks`) : les tâches restent écrites dans
// le projet et repartent quand on le rallume.
export const tasksPlugin: AgentPlugin = {
  id: "tasks",
  Rail: () => <TaskQueueButton />,
  // Une tâche de la file attendait peut-être ce tour.
  turnEnded: taskTurnEnded,
}
