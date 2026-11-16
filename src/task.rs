use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TaskId(pub String);

impl TaskId {
    #[allow(dead_code)]
    pub fn new() -> Self {
        Self(Uuid::new_v4().to_string())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TaskStatus {
    Queued,
    Planning,
    Running,
    WaitingForApproval,
    NeedsAttention,
    Complete,
    Warning,
    Failed,
    Cancelled,
    Disconnected,
    Unavailable,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TaskPlan {
    pub steps: Vec<TaskPlanStep>,
    pub current_step: Option<usize>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TaskPlanStep {
    pub id: String,
    pub title: String,
    pub status: TaskStepStatus,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TaskStepStatus {
    Pending,
    Active,
    Complete,
    Warning,
    Failed,
    Blocked,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Task {
    pub id: TaskId,
    pub title: String,
    pub user_goal: Option<String>,
    pub repository_id: super::repository::RepositoryId,
    pub branch: Option<String>,
    pub working_directory: Option<String>,
    pub status: TaskStatus,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub messages: Vec<super::events::ChatMessage>,
    pub plan: Option<TaskPlan>,
    pub tool_events: Vec<super::events::ToolEvent>,
    pub artifacts: Vec<super::events::Artifact>,
    pub approvals: Vec<super::events::ApprovalRequest>,
    pub summary: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_id_new_generates_unique_ids() {
        let id1 = TaskId::new();
        let id2 = TaskId::new();
        assert_ne!(id1, id2);
        assert!(!id1.0.is_empty());
        assert!(!id2.0.is_empty());
    }

    #[test]
    fn task_id_round_trips_through_json() {
        let id = TaskId("test-id-123".to_string());
        let json = serde_json::to_string(&id).unwrap();
        let decoded: TaskId = serde_json::from_str(&json).unwrap();
        assert_eq!(id, decoded);
    }

    #[test]
    fn task_status_serializes_to_expected_strings() {
        let cases = [
            (TaskStatus::Queued, "\"Queued\""),
            (TaskStatus::Running, "\"Running\""),
            (TaskStatus::Complete, "\"Complete\""),
            (TaskStatus::Failed, "\"Failed\""),
            (TaskStatus::Cancelled, "\"Cancelled\""),
        ];
        for (status, expected) in cases {
            let json = serde_json::to_string(&status).unwrap();
            assert_eq!(json, expected, "status {:?} mismatch", status);
        }
    }

    #[test]
    fn task_status_round_trips_through_json() {
        let statuses = vec![
            TaskStatus::Queued,
            TaskStatus::Planning,
            TaskStatus::Running,
            TaskStatus::WaitingForApproval,
            TaskStatus::NeedsAttention,
            TaskStatus::Complete,
            TaskStatus::Warning,
            TaskStatus::Failed,
            TaskStatus::Cancelled,
            TaskStatus::Disconnected,
            TaskStatus::Unavailable,
        ];
        for status in statuses {
            let json = serde_json::to_string(&status).unwrap();
            let decoded: TaskStatus = serde_json::from_str(&json).unwrap();
            assert_eq!(status, decoded);
        }
    }

    #[test]
    fn task_step_status_round_trips() {
        let statuses = vec![
            TaskStepStatus::Pending,
            TaskStepStatus::Active,
            TaskStepStatus::Complete,
            TaskStepStatus::Warning,
            TaskStepStatus::Failed,
            TaskStepStatus::Blocked,
        ];
        for status in statuses {
            let json = serde_json::to_string(&status).unwrap();
            let decoded: TaskStepStatus = serde_json::from_str(&json).unwrap();
            assert_eq!(status, decoded);
        }
    }

    #[test]
    fn task_plan_serializes_with_optional_current_step() {
        let plan = TaskPlan {
            steps: vec![TaskPlanStep {
                id: "s1".to_string(),
                title: "First step".to_string(),
                status: TaskStepStatus::Pending,
                started_at: None,
                completed_at: None,
            }],
            current_step: None,
        };
        let json = serde_json::to_string(&plan).unwrap();
        assert!(json.contains("\"current_step\":null"));
        let decoded: TaskPlan = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded.steps.len(), 1);
        assert!(decoded.current_step.is_none());
    }
}
