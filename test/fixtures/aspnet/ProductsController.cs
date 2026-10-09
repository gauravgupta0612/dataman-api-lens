using Microsoft.AspNetCore.Mvc;

[ApiController]
[Route("api/[controller]")]
public class ProductsController : ControllerBase
{
    [HttpGet("{id:int}")]
    public async Task<ActionResult<Product>> Get(int id, [FromQuery] bool includeStock, CancellationToken ct) => Ok();

    [HttpPost]
    [ProducesResponseType(typeof(Product), 201)]
    public IActionResult Create([FromBody] CreateProduct body, [FromHeader(Name = "X-Api-Key")] string key) => Ok();
}

public record CreateProduct(string Name, decimal Price, int? Stock);

public class Program {
  static void Main() {
    var app = builder.Build();
    var todos = app.MapGroup("/todos");
    todos.MapGet("/{id}", async (int id, TodoDb db) => await db.Todos.FindAsync(id));
    todos.MapPost("/", (Todo todo, TodoDb db) => Results.Created());
  }
}
public class Todo { public int Id { get; set; } public string Title { get; set; } public bool Done { get; set; } }
