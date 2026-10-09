package com.example;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/users")
public class UserController {

    @GetMapping("/{id}")
    public UserDto get(@PathVariable Long id, @RequestParam(required = false) String fields) { return null; }

    @PostMapping
    public UserDto create(@RequestBody @Valid UserDto dto, @RequestHeader("X-Request-Id") String rid) { return dto; }

    @RequestMapping(value = "/search", method = {RequestMethod.GET, RequestMethod.POST})
    public List<UserDto> search(Pageable pageable, @RequestParam String q) { return null; }

    // @GetMapping("/commented")
}

class UserDto {
    @NotNull
    private String name;
    private String email;
    private Integer age;
    private List<String> roles;
}
