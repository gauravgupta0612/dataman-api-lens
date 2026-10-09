import io.ktor.server.routing.*
fun Application.routes() {
    routing {
        route("/api") {
            get("/orders/{id}") {
                val id = call.parameters["id"]
                val expand = call.request.queryParameters["expand"]
            }
            post("/orders") {
                val o = call.receive<OrderDto>()
            }
        }
    }
}
data class OrderDto(val item: String, val qty: Int, val note: String? = null)
