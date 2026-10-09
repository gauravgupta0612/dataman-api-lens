use axum::{routing::{get, post}, Router, Json, extract::{Path, Query}};
#[derive(Deserialize)]
struct NewUser { name: String, email: Option<String> }
#[derive(Deserialize)]
struct Paging { page: u32, per_page: u32 }
fn app() -> Router {
    Router::new()
        .route("/users", get(list_users).post(create_user))
        .route("/users/:id", get(get_user))
        .nest("/admin", admin_routes())
}
fn admin_routes() -> Router { Router::new().route("/stats", get(stats)) }
async fn list_users(Query(p): Query<Paging>) -> String { String::new() }
async fn create_user(Json(body): Json<NewUser>) -> String { String::new() }
