const users = [] 

const findByEmail = async (email) => {
  return users.find((user) => user.email === email)
}

const findById = async (id) => {
  return users.find((user) => user.id === id)
}

const create = async (userData) => {
  const newUser = { id: Date.now().toString(), ...userData }
  users.push(newUser)
  return newUser
}

module.exports = {
  findByEmail,
  findById,
  create,
}
