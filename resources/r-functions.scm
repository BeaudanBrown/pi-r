(program
  (binary_operator
    lhs: (identifier) @top.name
    rhs: (function_definition
      parameters: (parameters) @top.parameters
      body: (_) @top.body) @top.function))

(binary_operator
  lhs: (identifier) @assigned.name
  rhs: (function_definition) @assigned.function)
